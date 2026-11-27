# Research: Bluetooth Local Transport

Phase 0 decisions for [spec.md](./spec.md). Each entry gives the decision, why, and what was rejected. "Spike" means a decision that must be confirmed on real hardware before the dependent work starts (see Phase A in [plan.md](./plan.md)).

Sources checked during planning (2026-11-27):

- Web Bluetooth exposes no MTU and no documented maximum for `writeValueWithoutResponse`; the Chrome `getDevices()` / `watchAdvertisements()` feature lets a page reconnect to devices the origin already has permission for, without the chooser ([Chrome intent to ship](https://groups.google.com/a/chromium.org/g/blink-dev/c/lqCQ63CTKEQ), [MTU API request](https://github.com/WebBluetoothCG/web-bluetooth/issues/383)).
- Windows can act as a GATT server through `GattServiceProvider` since Windows 10 Creators Update, but only on radios that support the peripheral role ([Microsoft GATT server docs](https://learn.microsoft.com/en-us/windows/apps/develop/devices-sensors/gatt-server), [peripheral role note](https://techcommunity.microsoft.com/t5/Microsoft-Bluetooth-Blog/Declaring-Bluetooth-Peripheral-Role-Support-for-Windows/ba-p/506355)).
- The Node peripheral library `bleno` talks to the radio over raw HCI; on Windows that needs a WinUSB driver swap (Zadig) and a dedicated USB adapter, so it is not viable for a consumer desktop app ([bleno](https://github.com/noble/bleno)).

---

## R-01 Roles: the browser is the Bluetooth central, the Hub is the peripheral

**Decision.** A browser client uses Web Bluetooth as a GATT *client* (central). A Hub is a GATT *server* (peripheral) that advertises one service. Browsers never connect to each other.

**Why.** Browsers cannot advertise or accept connections. This is the constraint that forced Bluetooth out of spec 001 v1; the Hub turns it into the design.

**Rejected.** Browser-to-browser over Bluetooth (impossible); a Hub that is a central connecting to browsers (impossible, browsers do not advertise); classic Bluetooth RFCOMM (no browser access, and not what Web Bluetooth speaks).

**Consequence.** Client support is whatever Web Bluetooth supports: Chromium on Android, Windows, macOS, Linux and ChromeOS. Safari, Firefox and iOS browsers report `unsupported`. This is already an accepted limit in the spec (Assumptions).

## R-02 One GATT service, three characteristics

**Decision.** Service `link/1` with:

| Characteristic | Properties | Purpose |
|---|---|---|
| `INFO` | read | Hub display name, link protocol range, Hub fingerprint, current mode (open or approval), `full` flag, and the Hub's largest accepted write size |
| `TX` | write without response (and write, as fallback) | Client to Hub link frames |
| `RX` | notify | Hub to client link frames |

UUIDs are in [contracts/bluetooth-link.md](./contracts/bluetooth-link.md).

**Why.** Two data pipes plus a read-only descriptor are the least that works everywhere. Write-without-response and notifications are the highest-throughput GATT operations and are available to Web Bluetooth.

**Rejected.** One characteristic per Space or per lane (more attribute discovery time, and leaks Space structure to scanners); indicate instead of notify (round trip per frame); a second service for blobs (the frame header carries a stream bit instead, R-04).

## R-03 Frame size is negotiated, because the browser cannot see the MTU

**Decision.** The link starts at a 20-byte safe frame (works at the default ATT MTU of 23). After the secure handshake the client sends `PROBE` frames of increasing size (ladder 64, 128, 182, 244). The Hub reports the largest it received intact and its own notification limit (it knows its MTU), and both sides use the smaller. Chunk size is re-probed on each connection and never cached.

**Why.** Web Bluetooth gives no MTU, and documented write limits are absent, so guessing would either waste throughput or fail on weak adapters. Probing is cheap (under 1 KiB) and self-correcting.

**Rejected.** A fixed 182-byte frame (fails on some Android versions and desktop adapters); assuming 512 (the ATT attribute maximum, not the link payload); reading the MTU from a Hub characteristic (the Hub-side MTU is not the write limit the browser's stack enforces).

**Spike S-2** measures the probe ladder on real browsers and adapters.

## R-04 Framing: two streams, windowed flow control, message-level encryption

**Decision.** Every message is encrypted whole (R-06), then split into frames:

- 2-byte frame header: byte 0 holds the frame type (`DATA`, `ACK`, `PROBE`) and the `STREAM`, `START`, `END` flags; byte 1 is an 8-bit sequence per stream and direction. An `ACK` frame carries the highest in-order sequence.
- **Stream 0** carries control and packet messages. **Stream 1** carries the binary lane (spec 004 blobs). The scheduler sends at most 4 consecutive stream-1 frames before giving stream 0 a turn, so a blob cannot delay packets by more than a few frames.
- Window: at most 32 unacknowledged frames per direction; the receiver acks every 16.
- A gap in sequence aborts the current message (partial discarded, `link.error: frame-gap`); the sync layer's summary exchange re-requests it. Reassembly times out after 30 s.

**Why.** Write-without-response has no application acknowledgment, and Android and desktop stacks can drop writes when their queue overflows. A window keeps the sender within what the stack buffers, and the sequence catches drops. Two streams give the "normal packet sync is not starved" behavior required by spec US5 without a second connection.

**Rejected.** Letting GATT do all the reliability (a dropped write would silently corrupt a message); a window of one (throughput collapse, a connection interval per frame); reordering support (GATT is ordered per characteristic).

## R-05 Message sizes and blob policy

**Decision.** `capabilities.maxMessageBytes = 512 KiB` (covers the 001 envelope limit of 256 KiB and the 004 blob chunk of 256 KiB plus lane overhead). Realistic GATT throughput is 10 to 100 KB/s, so the transport advertises `blobs: false` and the Bluetooth module sets a default **blob auto-transfer ceiling of 5 MiB** per blob. Larger blobs show "waits for a faster transport" (spec US5, scenario 3) and transfer automatically as soon as one is connected. The ceiling is configurable per app.

**Why.** At 20 KB/s a 5 MiB blob takes about 4 minutes, which is the most a person at a campsite will tolerate in the background. Packets are small, so object sync stays fast: a 1,000-object Space of about 1 KiB packets is about 1 MiB, roughly 10 to 50 seconds (SC-001 allows 5 minutes).

## R-06 Link encryption hides metadata from radio eavesdroppers

**Decision.** After `LINK_HELLO`, client and Hub run an ephemeral X25519 key agreement; the Hub signs the transcript with its long-lived Ed25519 Hub key. Session keys come from HKDF-SHA-256; each direction encrypts every message with AES-256-GCM using a counter nonce. The Hub key is verified against the fingerprint the user confirmed on first use.

**Why.** Packet payloads are already end-to-end encrypted (spec 002), but packet envelopes expose Space IDs, author IDs and clocks. Over a Bluetooth link without pairing, anyone with a sniffer in range could read them. Spec FR-025 and Constitution V ask for the minimum metadata exposure; this closes the air gap cheaply. It is also what makes the Hub's identity checkable, so a rogue Hub cannot impersonate a trusted one to harvest connections.

**Rejected.** OS-level BLE pairing and bonding (Web Bluetooth cannot drive it, results differ per OS, and bonding prompts break the "no code to type" experience); no link encryption (leaks metadata); TLS (not available over GATT).

The Hub key and fingerprint are **not** content authority: a Hub that is fully compromised still sees only ciphertext (spec FR-011).

## R-07 Membership proof without giving the Hub a decryption key

**Decision.** Each Space epoch key derives a separate **access keypair**: `HKDF(epochKey, info = "sync-hub-access/1" || spaceId)` seeds an Ed25519 key. The public key goes into the serve-Space code. A member's app signs the Hub's challenge with the derived private key. The Hub verifies against the registered public key. The derivation is one-way and domain-separated from every encryption key, so the Hub can verify membership but cannot decrypt anything or recover the epoch key.

**Why.** The spec requires "proves membership in a served Space" (FR-016) but also "never holds Space keys" (FR-011), and role lists are encrypted, so the Hub cannot check a member list. A derived verification key satisfies both. It needs a small additive amendment to spec 002 (S-2, [contracts/amendments.md](./contracts/amendments.md)).

**Consequences and limits.**

1. **Rotation.** When a member is removed and a new epoch starts, the removed member can still sign with the old access key. The owner re-exports the serve code for the new epoch (the app prompts "Update Hub codes"); the Hub keeps the old public key for the retention period so lagging clients still sync, then drops it. The data a removed member can obtain is ciphertext they cannot read for the new epoch. Automatic renewal is deferred (open item O-1).
2. **Automatic Space mode.** There is no code to import, so the Hub registers the first access public key presented for a Space (trust on first use) within per-Space caps. A stranger who knows a Space ID could register first and lock members out of *that Hub*. Mitigations: caps, owner list of auto-added Spaces with removal, approval mode, and members keep working through other transports. This is accepted and recorded as risk RK-3.
3. **Hub-to-Hub.** A Hub that links to another Hub must sign as a member, so a **link code** variant of the serve code also carries the access *private* key. It cannot decrypt content, but whoever holds it can pass membership checks, so it is shown with a warning and used only for Hub-to-Hub. FR-030 in the spec is worded accordingly: serve codes carry no *content* keys.

**Rejected.** Hub learns the member list (leaks roles, breaks Principle V); shared secret "join PIN" (static, leaks to anyone who sees one connection); verifying device signatures on packets only (does not stop storage-flooding by non-members, and the Hub cannot check roles); giving the Hub the Space key (violates FR-011).

## R-08 The Hub is a RelayHub with persistence and an admission gate

**Decision.** Reuse `RelayHub` from `packages/relay-server` (it already speaks the sync protocol, stores opaque packets, supports the wildcard Space, and carries the 004 binary lane and `BlobRelay`). Extract the reusable core into a new `@sync/hub-core` package and add what the Hub needs: a persistent store, an admission gate, retention, capacity limits, and the Bluetooth link server. Two small additive amendments to the relay code (R-2): a pluggable `HubStore`, and an `admit(peerId, spaceId)` callback so the wildcard `hello` is narrowed to the Spaces that peer is allowed to use.

**Why.** All the hard sync behavior (summaries, resume, dedup, no loops, relay rules, blob lane) already exists and is tested. The Hub then only adds transport, access, and persistence. It also keeps Principle IV: the core does not know about Bluetooth.

**Rejected.** A separate Kotlin or Swift implementation of the sync protocol per platform (three diverging copies of subtle convergence logic); making the browser app run as the Hub (it cannot be a peripheral).

## R-09 One Hub codebase, two native shells

**Decision.** `@sync/hub-core` and `@sync/hub-ui` (owner screens as Web Components) are shared TypeScript. Two shells host them:

- **Android Hub**: Capacitor app. A Kotlin plugin implements `BleBridge` with `BluetoothGattServer`, `BluetoothLeAdvertiser` and, for Hub-to-Hub, `BluetoothGatt` (central). It runs the Hub core in the WebView with a **foreground service** and notification so the Hub keeps working with the screen off.
- **Desktop Hub**: Electron app. The Hub core runs in the main process (Node). A `BleBridge` implementation per OS: **Windows** `GattServiceProvider` (WinRT) and `BluetoothLEAdvertisementWatcher` through a small sidecar program talking JSON lines over stdio; **macOS** `CBPeripheralManager`/`CBCentralManager` through a Swift sidecar with the same protocol; **Linux** BlueZ `GattManager1`/`LEAdvertisingManager1` over D-Bus from Node.

The `BleBridge` contract ([contracts/hub-ble-bridge.md](./contracts/hub-ble-bridge.md)) is the same for all four, with a shared `bleBridgeContract()` test suite.

**Why.** This is the smallest number of native components (one Kotlin plugin, up to three small sidecars) with all sync logic shared. Windows and macOS peripherals need OS APIs that Node cannot reach without native code, and `bleno` is rejected (see sources above).

**Rejected.** Tauri or a pure-native app per OS (more code, no reuse of `RelayHub`); `bleno` as the only desktop BLE layer (Windows unviable; macOS and Linux fine but then the Windows gap would need the sidecar anyway); Flutter (a fourth implementation of the Hub logic).

**Risk RK-1.** Windows peripheral support depends on the radio. The Windows sidecar checks `BluetoothAdapter.IsPeripheralRoleSupported` and the Hub reports "this computer's Bluetooth adapter cannot act as a Hub" instead of failing silently. **Spike S-1** confirms the Windows, macOS and Linux bridges before the desktop Hub is committed to.

## R-10 Hub persistence

**Decision.** `HubStore` interface in `@sync/hub-core`, with:

- **Reference implementation**: per-Space, day-sharded append-only segment files plus a small index (packet ID to segment offset, per-packet delivery count). Retention deletes whole expired day-shards (default 14 days, spec FR-009). The oldest-delivered-first rule uses the delivery count: packets delivered to at least one other peer are evicted before undelivered ones.
- Blobs reuse the existing `createFileBlobStorage` and `BlobRelay` caps and TTL/LRU, with Hub-level overall storage limits.
- Android: the same code over a Capacitor filesystem adapter; desktop: Node `fs`.

**Why.** The existing relay keeps packets in memory and relies on clients to resend after a restart (spec 001 decision). A Hub left on for days, whose original authors have gone home, cannot: the Hub is sometimes the only copy. So it must persist. Append-only segments are crash-safe (a torn last record is discarded on open), need no native database, and make day-based retention a file delete.

**Rejected.** SQLite (a native module per platform, packaging pain on Electron and Capacitor, for a workload that is append-and-scan); IndexedDB inside the Android WebView (eviction by the OS under storage pressure).

## R-11 Connection model: short sync bursts, not long-lived links

**Decision.** Clients are designed to connect, sync, and optionally stay connected for live updates; the Hub never assumes a client stays. The Hub reports capacity as "slots", and when full it answers `LINK_BUSY` with a retry hint. Clients that cannot get a slot retry with jittered backoff and sync in short bursts. The default maximum concurrent clients is the lower of 7 and what the platform reports; it is configurable.

**Why.** Phone and desktop controllers usually cap simultaneous BLE connections at about 7. The spec says a Hub serves at least 8 clients; storing and forwarding makes that true over time even when not all 8 are connected at once. Because the Hub stores and forwards, a burst model delivers the same end state. The spec's wording is adjusted to match (Assumptions and SC-009).

**Spike S-3** measures real concurrent-connection limits on target Android phones and desktop adapters.

## R-12 Background operation

**Decision.**

- Android Hub: a foreground service with a persistent notification; optional wake lock; battery-optimization exemption is explained in the first-run screen. Clients that are backgrounded may be suspended by the browser; sync resumes when the page is active (spec edge case).
- Desktop Hub: tray application, "keep awake while Hub is running" option.
- Client browsers: Web Bluetooth only works while the page is open; closing the tab disconnects. The app's outbox keeps changes safe and sync resumes on reopen.

**Why.** Platform limits mean "runs unattended" is a Hub-device capability, not a client one. The spec scopes unattended operation to the Hub (FR-008).

## R-13 Discovery and reconnection

**Decision.** The Hub advertises the service UUID and a short display name (owner may replace the name with "Hub-XXXX" to avoid naming people). Nothing about Spaces is advertised. First use goes through the browser's device chooser (`requestDevice` filtered by the service UUID), which needs a user gesture. After the user has chosen a Hub once, the client uses `getDevices()` and `watchAdvertisements()` where available to reconnect without the chooser; where unavailable it shows a one-tap "reconnect" button.

**Why.** The chooser is mandatory in Web Bluetooth for first contact; everything else follows from the permission already granted. Not advertising Spaces satisfies FR-014 before any link is up.

## R-14 Hub-to-Hub linking

**Decision.** A Hub with a link code for a Space scans for other Hubs advertising the service and, when both have the Space, connects as a central, runs the same link handshake with the access private key, and syncs through the normal sync protocol with `relay` on. Only one of two Hubs that see each other initiates (lower fingerprint wins) to avoid duplicate links. This is lower priority than client sync (plan Phase D).

**Why.** Reuses the entire client path; only the roles are swapped. Requires the central role in every `BleBridge`, which is why the bridge contract includes it.

## R-15 Testing without radios

**Decision.** A deterministic `MemoryBleLink` in `@sync/testkit` simulates GATT: configurable MTU, write size limit, loss, duplication (never reordering), latency, and disconnects, with a fake peripheral and central. The `Transport` contract suite and `laneContract()` run against the client transport through it. `bleBridgeContract()` runs against each real bridge in manual or hardware CI jobs and against a mock bridge in normal CI. Known-answer vectors cover the frame format and handshake. Physical-device validation is a listed manual matrix in [quickstart.md](./quickstart.md).

**Why.** Principle VIII requires contract tests, and radios cannot run in CI. The simulator exercises the failure modes that matter (small MTU, drops, reconnects) deterministically.

## R-16 Versioning and compatibility

**Decision.** The link protocol has its own `{min, max}` range in `INFO` and `LINK_HELLO`, independent of the sync protocol. An incompatible future link version uses a new service UUID, so old clients never connect to a Hub speaking something they cannot parse and instead see "update needed" (spec edge case). Frame and handshake changes that are additive bump the minor version only.

**Why.** Constitution Development Workflow requires a compatibility note; the sync protocol and packet envelope are unchanged, so the only new surface is the link layer.

## R-17 Performance goals

| Measure | Goal | Measured how |
|---|---|---|
| 1,000-object Space (about 1 MiB) first sync | under 2 minutes at 20 KB/s, under 30 s at 100 KB/s | simulator at both rates; real devices in validation |
| Edit to appearing on another client | p95 under 3 s (SC-002) | two clients on one Hub |
| Packet latency while a blob streams | p95 at most 2x idle | stream-fairness test in simulator |
| Resumed sync re-sends | 0 delivered packets (SC-003) | interrupt/resume property test |
| Hub idle battery | recorded per device in `validation.md`; no fixed target (SC-009 is about not losing packets) | 8-hour soak |

## Open items

- **O-1** Automatic renewal of serve codes after epoch rotation (today: owner re-imports).
- **O-2** Whether the Hub should also serve its own Web page over a local transport for owner remote control (out of scope for v1).
- **O-3** Hub management UI localization (English only in v1).
