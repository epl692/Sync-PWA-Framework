---

description: "Task list for Bluetooth Local Transport (005-bluetooth-transport)"
---

# Tasks: Bluetooth Local Transport

**Input**: Design documents from `/specs/005-bluetooth-transport/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md). Specs 001 to 004 are implemented and their suites are green.

**Tests**: INCLUDED and written first. Constitution Principle VIII requires test-first work, reusable contract suites (`bleBridgeContract`, `hubStoreContract`, plus the existing `transportContract` and `laneContract`) and property-based tests for convergence. Within each phase, run the test tasks and confirm they FAIL before starting the implementation tasks.

**Organization**: Tasks are grouped by user story. Priority order is P1 (US1, US2), P2 (US3, US4), P3 (US5). US1 is the MVP. US2 builds on the US1 link and Hub; US3 needs only the US1 link; US4 needs the US1 Hub plus the store; US5 needs the US1 link and the 004 blob code. Foundational phase 2 carries what every story shares: the spaces amendment, the link codec and crypto, the relay amendment, the radio simulator, and the contract suites.

**Manual tasks**: tasks marked **MANUAL, hardware** need real phones, laptops, or radios and cannot run in CI. They are listed so nothing is forgotten; their results go in `specs/005-bluetooth-transport/validation.md`.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an unfinished task)
- **[Story]**: US1 to US5, matching the stories in spec.md
- Paths follow plan.md. Library code is under `packages/{transport-bluetooth,hub-core,hub-ui}/{src,tests}`; native shells are under `hubs/{desktop,android}`.
- `specs/005-bluetooth-transport/contracts/*` is the source of truth for names, byte layouts, and signatures; copy types from `transport-bluetooth.ts` and `hub-core.ts` rather than redesigning. `bluetooth-link.md`, `hub-access.md` and `hub-ble-bridge.md` are normative.
- "Existing" test helpers (`testCore`, `peers`, `memoryTransport`, `secureNode`, `hubTransport`, `plaintextScan`) live in `packages/testkit/src/`.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: New packages, build wiring, guard rails, and the hardware spikes that gate the native work.

- [X] T001 Scaffold `packages/transport-bluetooth` (`@sync/transport-bluetooth`): `package.json` shaped like `packages/transport-webrtc/package.json` with `main`/`types` and `exports` for `.` (`./src/index.ts`) and `./link` (`./src/link/index.ts`, the pure link codec and session crypto with NO Web Bluetooth imports, reused by the Hub), `@sync/core` as the only runtime dependency, `@types/web-bluetooth` as a devDependency, `tsconfig.json`, `vitest.config.ts`, and empty `src/index.ts` and `src/link/index.ts`
- [X] T002 [P] Scaffold `packages/hub-core` (`@sync/hub-core`): `package.json` with `main`/`types`/`exports`, runtime dependencies limited to workspace packages `@sync/core`, `@sync/blobs` and `@sync/transport-bluetooth` (import only through its `./link` subpath), NO third-party runtime dependency, `tsconfig.json`, `vitest.config.ts`, empty `src/index.ts`
- [X] T003 [P] Scaffold `packages/hub-ui` (`@sync/hub-ui`): native Web Components only (no framework), `package.json`, `tsconfig.json`, `vitest.config.ts` (jsdom), empty `src/index.ts`
- [X] T004 [P] Add `@sync/transport-bluetooth`, `@sync/transport-bluetooth/link`, `@sync/hub-core` and `@sync/hub-ui` to `paths` in `tsconfig.base.json`; add root npm scripts `test:bluetooth` (`vitest run packages/transport-bluetooth`) and `test:hub` (`vitest run packages/hub-core packages/hub-ui`) to `package.json`; update `scripts/build.mjs` so `hub-core` builds with `platform: 'node'` and the other two for the browser; confirm `npm run build` passes
- [X] T005 [P] Release-surface guard tests in `packages/hub-core/tests/unit/release-surface.test.ts` and `packages/transport-bluetooth/tests/unit/release-surface.test.ts`: `@sync/transport-bluetooth` has `@sync/core` as its only runtime dependency and no file under its `src/` imports `@sync/testkit`; `@sync/hub-core` has no third-party runtime dependency; NO file under `packages/hub-core/src/` imports `@sync/spaces` (the Hub holds no content keys, spec FR-011, SC-004); `packages/transport-bluetooth/src/link/` imports nothing from `@sync/spaces` and nothing that touches `navigator`
- [X] T006 [P] Add `eslint.config.js` blocks that (a) ban any `@sync/spaces` import inside `packages/hub-core/src/`, (b) ban `navigator.bluetooth` outside `packages/transport-bluetooth/src/webBluetooth.ts`, and (c) ignore `hubs/**` native sources for TypeScript rules apart from `hubs/*/src`
- [X] T007 [P] Create `hubs/README.md` explaining that `hubs/desktop` and `hubs/android` are built outside the npm workspaces (native toolchains), exclude `hubs/**` from the root `tsconfig.json` `include` and from `vitest.config.ts`, and create empty `hubs/desktop/` and `hubs/android/` folders with a one-line `README.md` each
- [ ] T008 [P] **MANUAL, hardware.** Spike S-1: minimal Hub bridges on Windows (WinRT `GattServiceProvider`), macOS (`CBPeripheralManager`) and Linux (BlueZ `GattManager1`): advertise service `a89242f7-786e-4bf2-9b00-b028957dc0eb`, accept a Chrome connection, echo 10 KiB over `TX`/`RX`. Record results per OS and adapter in `specs/005-bluetooth-transport/validation.md` (create it with a "Spikes" section). If an OS fails, record it and mark its desktop shell tasks as deferred
- [ ] T009 [P] **MANUAL, hardware.** Spike S-2: measure the `PROBE` ladder (64, 128, 182, 244 bytes) with Web Bluetooth write-without-response on Chrome Android, and Chrome on Windows, macOS and Linux, against a phone Hub and a desktop Hub; record the largest size received intact per pairing in `validation.md`. If 20 bytes is the best case on any pairing, record measured throughput and confirm SC-001 is still reachable
- [ ] T010 [P] **MANUAL, hardware.** Spike S-3: measure the maximum concurrent central connections on two target Android phones and one desktop adapter; record in `validation.md` and set the platform default for `maxClients` (`min(7, measured limit)`)
- [ ] T011 [P] **MANUAL, hardware.** Spike S-4: record whether `navigator.bluetooth.getDevices()` and `BluetoothDevice.watchAdvertisements()` are usable (without a flag) in each in-scope browser and OS; record in `validation.md` and adjust the reconnect plan in research R-13 if either is missing

**Checkpoint**: packages build; spike findings recorded. Native shell work (US1 Hub shells) waits for the matching spike.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Hub access derivation (spaces amendment S-2), the link codec and crypto, the relay amendment R-2, the radio simulator and reusable contract suites, and the in-memory store. Every story needs these.

**CRITICAL**: No user story work starts until this phase is complete. Test tasks come before their implementation tasks; confirm each new test FAILS first.

### Spaces amendment S-2 (access keys and codes)

- [X] T012 [P] Known-answer vectors test in `packages/spaces/tests/vectors/hub-access.test.ts` for `deriveHubAccess`: `HKDF-SHA-256(ikm = epochKey, salt = 0x00*32, info = "sync-hub-access/1" || spaceId(16 B) || epoch(4 B BE), length = 32)` seeds an Ed25519 key; proof `sig = Ed25519(accessPrivate, "sync-hub-auth/1" || hubFingerprintBytes || nc || nh || spaceId || epoch(4 B BE))`; vectors fixed from a documented independent computation, plus a property test (fast-check) that the access key never equals any other key derived in `contracts/crypto-envelope.md` and that nothing derivable from the access key decrypts a generated packet or blob (use `plaintextScan` from `packages/testkit/src/spaces/plaintextScan.ts`)
- [X] T013 Implement `packages/spaces/src/hubAccess.ts`: `deriveHubAccess(epochKey, spaceId, epoch)`, `proveHubChallenge(...)`, and register the label `"sync-hub-access/1"` in `specs/002-spaces-security-identity/contracts/crypto-envelope.md` (depends on T012)
- [X] T014 [P] Tests in `packages/spaces/tests/unit/hub-codes.test.ts` for `exportHubCode`: text form `syncserve:1:` + base64url(UTF-8 JSON) with fields `v`, `kind` (`serve` or `link`), `space`, `epoch`, `accessPublic` (32 B), optional `name`, `createdAt`, optional `expiresAt`; a `link` code adds `accessSecret` (32 B); neither kind contains the Space key, epoch key, write key, member list, roles, object data, or device keys; export requires the caller to be a current member at their latest epoch
- [X] T015 Implement `exportHubCode(space, { link?, name?, expiresAt? })` and the code parser/validator (rejects unknown `v`, wrong lengths, expired codes) in `packages/spaces/src/hubCodes.ts` (depends on T013, T014)
- [X] T016 Implement the `HubProofProvider` adapter from `specs/005-bluetooth-transport/contracts/transport-bluetooth.ts` in `packages/spaces/src/service/hubAccess.ts` as `spaces.hubAccess.proofs` (`spaces()`, `proveSpace`, `proveDevice`, `accessPublic`; challenge passed as `hubFingerprint`, `nc`, `nh`) with tests in `packages/spaces/tests/integration/hub-access.test.ts`; export all new functions from `packages/spaces/src/index.ts` (depends on T015)

### Link codec and crypto (shared by client and Hub)

- [X] T017 [P] Tests in `packages/transport-bluetooth/tests/link/frames.test.ts` and `packages/transport-bluetooth/tests/property/frames.property.test.ts`: byte layout vectors for `byte 0 = type (2 bits: 00 DATA, 01 ACK, 10 PROBE, 11 reserved) | stream (1 bit) | START | END | 3 reserved bits MUST be 0`, `byte 1 = seq (8-bit, per stream and direction)`; property: any message split at any `frameBytes` in 20..244 reassembles to the original; dropped or duplicated frames abort only the current message; reassembly over `maxMessageBytes + 24` aborts and counts a strike; partial messages older than 30 s are dropped; frames shorter than 2 bytes or with the reserved type abort the message; 3 such frames within 10 s close the link
- [X] T018 Implement `packages/transport-bluetooth/src/link/frames.ts` (encode, decode, reassembler with per-stream sequence tracking) and export it from `src/link/index.ts` (depends on T017)
- [X] T019 [P] Tests in `packages/transport-bluetooth/tests/link/handshake.test.ts`: known-answer vectors for `hello`/`hello-ack` (`hello-ack.sig = Ed25519(hubKey, "sync-link/1" || clientEk || hubEk || nc || nh || hubFingerprintBytes)`; session keys `HKDF-SHA-256(ECDH(ekc, ekh), salt = nc || nh, info = "sync-link/1 keys")` giving two 32-byte AES-256 keys; nonce = 4 zero bytes + 8-byte counter); a replayed encrypted message is rejected (counter must be strictly greater than any previous in that direction); a wrong Hub key aborts with `hub-identity-changed`; a tampered nonce or transcript fails; kinds `0xF0` (hello), `0xF1` (hello-ack), `0xE0` (encrypted, `counter (8 B BE) | AES-256-GCM(inner)`), inner kinds `0x00` control JSON and `0x01` core message
- [X] T020 Implement `packages/transport-bluetooth/src/link/handshake.ts` and `packages/transport-bluetooth/src/link/session.ts` (X25519 + Ed25519 + HKDF + AES-GCM via Web Crypto, message kinds, counter handling, control-message JSON codec for `auth`, `auth-ok`, `pending`, `reject`, `probe-result`, `ping`, `pong`, `bye`, `error`); export from `src/link/index.ts` (depends on T019, T018)
- [X] T021 [P] Tests in `packages/transport-bluetooth/tests/link/scheduler.test.ts`: at most 32 unacknowledged DATA frames per stream and direction, receiver ACKs every 16 frames and at `END`, after 4 consecutive stream-1 frames the sender offers stream 0 a turn when it has frames queued, `PROBE` ladder 64/128/182/244 spaced 50 ms apart with `probe-result` choosing `min(largest received, Hub notify limit)`, write error halves `frameBytes` with floor 20
- [X] T022 Implement `packages/transport-bluetooth/src/link/scheduler.ts` (window, ACK, fairness, probing, halving) and export from `src/link/index.ts` (depends on T021, T018)

### Radio simulator and contract suites (testkit amendment T-2)

- [X] T023 [P] Tests for the simulator in `packages/testkit/tests/memoryBleLink.test.ts`: configurable `mtu`, `maxWriteBytes`, `lossRate`, `duplicateRate`, `latencyMs`, deterministic by seed, NEVER reorders per characteristic, supports connect/disconnect and adapter power off
- [X] T024 Implement `MemoryBleLink` (simulated GATT with fake peripheral and central endpoints and a `BluetoothLike` for the client transport) in `packages/testkit/src/ble/memoryBleLink.ts`; export from `packages/testkit/src/index.ts` (depends on T023)
- [X] T025 [P] Implement `bleBridgeContract()` in `packages/testkit/src/ble/bleBridgeContract.ts` covering the eight required behaviors in `specs/005-bluetooth-transport/contracts/hub-ble-bridge.md` (never-throwing `support()`, write boundaries preserved, notify never above `mtu - 3` and rejects `frame-too-large`, connection limit, `disconnected` exactly once, re-advertise after Bluetooth off/on, `setInfo` visible on next read, `close()` releases everything) plus `MockBleBridge` in `packages/testkit/src/ble/mockBleBridge.ts` built on `MemoryBleLink`; run the suite against the mock in `packages/testkit/tests/mockBleBridge.contract.test.ts`
- [X] T026 [P] Implement `hubStoreContract()` in `packages/testkit/src/hub/hubStoreContract.ts` for the `HubStore` interface in `specs/005-bluetooth-transport/contracts/hub-core.ts`: `addPacket` idempotent by id and returns false on duplicate, bytes returned exactly as stored (never re-encoded), `listIds` reports size/receivedAt/delivered, `markDelivered` increments, `enforce` deletes expired day shards first then evicts oldest packets with `deliveredCount >= 1` before any with `deliveredCount = 0` and reports `{expired, evictedDelivered, evictedUndelivered}`, crash safety hook (fault injection: a torn last record is discarded on reopen, earlier records intact)

### Relay amendment R-2 and in-memory store

- [X] T027 [P] Tests in `packages/hub-core/tests/admission.test.ts`: `admit(peerId, space)` is consulted for every Space a peer declares including the wildcard Space `*`, a denied Space is removed from that peer's effective `hello.spaces`, nothing is stored or forwarded for it, the default (no `admit`) allows everything; plus a persistence round-trip test using an injected `store`
- [X] T028 Move `RelayHub` (and its tests) from `packages/relay-server/src/relayHub.ts` to `packages/hub-core/src/relay/relayHub.ts`, re-export it from `packages/relay-server/src/index.ts` so existing imports keep working, add `RelayHubOptions.store` and `RelayHubOptions.admit` per `specs/005-bluetooth-transport/contracts/amendments.md` (R-2); the existing `packages/relay-server/tests/relayHub.test.ts`, `blob-relay.test.ts` and `file-blob-storage.test.ts` MUST stay green unchanged (depends on T027)
- [X] T029 [P] Hub settings and records in `packages/hub-core/src/settings.ts` with tests in `packages/hub-core/tests/settings.test.ts`: `displayName` string "1 to 32 chars" (default `Hub-XXXX` from the fingerprint), `accessMode` `open` | `approval` default `open`, `autoSpaces` default `false`, `maxClients` default `min(7, platform limit)` and at least 1, `retentionDays` default 14 "1 to 365", `storageLimitBytes` default 1 GiB, `perSpaceCapBytes` default 25% of the storage limit; reject invalid values with typed errors
- [X] T030 Implement `packages/hub-core/src/store/memoryStore.ts` (the `HubStore` interface) and run `hubStoreContract()` against it in `packages/hub-core/tests/store.memory.test.ts` (depends on T026, T029)
- [X] T031 Implement Hub identity in `packages/hub-core/src/identity.ts` with tests in `packages/hub-core/tests/identity.test.ts`: Ed25519 `hubKey` created on first run, `fingerprint` = readable form of SHA-256(public hubKey) as 8 groups of 4 base32 characters and also as 4 words from a bundled wordlist, stable across restarts
- [X] T032 Implement serve/link code import validation in `packages/hub-core/src/access/codes.ts` and membership proof verification in `packages/hub-core/src/access/verify.ts` (Ed25519 verify over `"sync-hub-auth/1" || hubFingerprintBytes || nc || nh || spaceId || epoch`, at most 2 epoch entries per Space per auth, unexpired registered keys only) with tests in `packages/hub-core/tests/access/verify.test.ts` using the vectors from T012; importing a newer epoch for a Space adds the key and sets `expiresAt` on older epochs to `replacedAt + retentionDays` (depends on T013, T029)
- [X] T033 [P] Pinned-Hub store in `packages/transport-bluetooth/src/trustStore.ts` (IndexedDB database `sync-bluetooth-v1`, record `TrustedHubRecord`: `fingerprint`, pinned `publicKey`, `name`, browser device identity, `autoReconnect`, `lastConnected`) with tests using `fake-indexeddb` in `packages/transport-bluetooth/tests/trustStore.test.ts`; every storage access wrapped so failure degrades to "no pinned Hubs"
- [X] T034 [P] Implement `packages/transport-bluetooth/src/status.ts` and tests `packages/transport-bluetooth/tests/status.test.ts`: `supported()` returns `unsupported` with reasons `no-web-bluetooth`, `insecure-context` or `no-bluetooth-adapter` (message tells the user which browser or setting is needed, FR-029); mapping of `BluetoothTransportStatus` to the 001 `TransportState` as documented in `contracts/transport-bluetooth.ts`

**Checkpoint**: link codec, access, relay amendment, simulator, and suites are green. User stories can start.

---

## Phase 3: User Story 1 - Sync Nearby Devices Through a Hub With No Network (Priority: P1) MVP

**Goal**: Browser clients connect to a Hub over Bluetooth and exchange changes with no network.

**Independent Test**: With the simulated radio, two clients and one Hub converge on a Space (quickstart section 2); on real devices, quickstart matrix rows 1 and 2 pass.

### Tests for User Story 1 (write first, confirm they FAIL)

- [X] T035 [P] [US1] `packages/transport-bluetooth/tests/contract.test.ts`: run `transportContract()` and `laneContract()` from `@sync/testkit` against the Bluetooth transport through `MemoryBleLink` at MTU 23, 185 and 247 (reliable air; loss and duplication are covered in US3 by the loss property test, because the Transport contract assumes no loss); include the unsupported-environment case via `createUnsupported`
- [X] T036 [P] [US1] `packages/hub-core/tests/integration/two-clients.test.ts`: Hub (with `MockBleBridge` and `memoryStore`) plus two client cores sharing a Space through `transport-bluetooth`; all packets each lacks are exchanged until both match (spec US1 scenario 1); an edit appears on the other client within 3 seconds on a virtual clock (SC-002); the client sync `hello.spaces` lists only the Spaces the Hub accepted; a Hub-side `admit` check drops any other Space
- [X] T037 [P] [US1] `packages/hub-core/tests/property/convergence.property.test.ts` (fast-check, `CONVERGENCE_RUNS` / `CONVERGENCE_SEED` like the 001 property tests): three clients and one Hub with random write order, random disconnects and reconnects, and frame loss always converge to the same state
- [ ] T038 [P] [US1] `tests/e2e/bluetooth-sim.spec.ts` (Playwright, Chromium): the demo page from T047 with two simulated clients and a simulated Hub; first-use confirmation takes at most 2 user confirmation steps (SC-005); a client with no Hub or an unsupported browser shows the "no Hub found / how to get one" message and the app still works on other transports (spec US1 scenario 4, SC-008)

### Client transport

- [X] T039 [US1] Implement `packages/transport-bluetooth/src/webBluetooth.ts`: the only file that touches `navigator.bluetooth`; `requestDevice` filtered by service UUID `a89242f7-786e-4bf2-9b00-b028957dc0eb`, GATT connect, characteristics `INFO` (`c71b9f0e-0fc5-48bd-9bff-6428700a9eea`, read), `TX` (`9ec66df3-0a3e-4c6a-a381-37405b5ac00c`, write without response with fallback to write), `RX` (`16d9aa8a-90ef-407b-a339-80534210840d`, notify); implements `BluetoothLike` so tests inject the simulator; `INFO` JSON parse with the 512-byte limit (depends on T034)
- [X] T040 [US1] Implement `packages/transport-bluetooth/src/clientLink.ts`: connection state machine `searching → connecting → securing (timeout 10 s) → authenticating (timeout 10 s) → [pending] → syncing ↔ idle`, handshake via T020, `auth` built from the `HubProofProvider` (`spaces`, `sig` per Space/epoch, `devSig`, device `name`), probe via T022, `busy` handling (disconnect and back off with jitter by `retryMs`), `reject` handling that never reveals which Spaces the Hub serves (depends on T039, T020, T022, T016)
- [X] T041 [US1] Implement the `Transport` in `packages/transport-bluetooth/src/index.ts` per `specs/005-bluetooth-transport/contracts/transport-bluetooth.ts`: `id: 'bluetooth'`, `capabilities { maxMessageBytes: 512 KiB, ordered: true, multiPeer: true, blobs: false }`, `supported()`, `start`, `connect`, `stop`, `send` (messages to stream 0 or 1 by lane magic), peers `hub:<fingerprint>` with `PeerInfo.label` = Hub name, events `connections` and `status`, `chooseHub()` requiring a user gesture, `connections()` reporting `HubConnectionInfo` including `frameBytes` (depends on T040, T033)
- [X] T042 [P] [US1] Register the transport as an ordinary module (spec 003) in `packages/transport-bluetooth/src/module.ts` with `BluetoothModuleConfig` (`enabledSpaces: string[] | 'all'`, options), declaring no object types, so apps can enable or disable it per app and per Space (FR-002); unit test in `packages/transport-bluetooth/tests/module.test.ts`
- [X] T043 [US1] Implement `<sync-bluetooth-panel>` in `packages/transport-bluetooth/src/ui/bluetooth-panel.ts` (native Web Component): lists Hubs and per-Hub state from `connections()`, "Find a Hub" button calling `chooseHub()`, clear messages for unsupported browser, Bluetooth off, permission denied and "no Hub found, here is how to run one" (FR-004, FR-029); labels and keyboard operation for accessibility; jsdom test in `packages/transport-bluetooth/tests/ui/bluetooth-panel.test.ts`

### Hub core

- [X] T044 [US1] Implement `packages/hub-core/src/link/server.ts`: for each `BleBridge` connection run the handshake from T020, wait for `auth`, verify proofs with T032, reply `auth-ok` (`state: "trusted"`, `accepted`, `rejected`), pass admitted core messages to `RelayHub` with the `admit` gate, enforce the connection slot limit (`maxClients`) with `hello-ack { busy: { retryMs } }`, send keepalive `ping` after 15 s idle and close after 3 missed, update the `INFO` characteristic (`slots`, `full`, `mode`, `name`, `fp`, `maxWrite`) through `bridge.setInfo`; an unauthenticated connection lives at most 20 s and may only send `auth` before `auth-ok` (depends on T028, T032, T031, T020, T018, T022)
- [X] T045 [US1] Implement `createHub` and `HubControl` from `specs/005-bluetooth-transport/contracts/hub-core.ts` in `packages/hub-core/src/hub.ts` and `packages/hub-core/src/index.ts`: start/stop, `addServeCode` (validates per `contracts/hub-access.md`), `spaces()`, `removeSpace`, `settings()`/`updateSettings`, `clients()`, events (`client-connected`, `client-disconnected`, `space-added`, `bridge-state`), and a Hub that serves ONLY Spaces whose code was added (automatic mode is User Story 2) (depends on T044, T030)
- [ ] T046 [P] [US1] Add a developer harness `packages/hub-core/dev.mjs` (script `hub:dev` in `packages/hub-core/package.json`, flag `--sim`) running the Hub with `MockBleBridge` and a console owner UI with commands `add-code <code>`, `clients`, `spaces`, `mode open|approval`, `approve <device>`, `block <device>`
- [ ] T047 [P] [US1] Demo page `packages/transport-bluetooth/demo/index.html` and `demo.ts` (script `dev` in `packages/transport-bluetooth/package.json`, like `packages/transport-webrtc/dev.mjs`) with two simulated clients, a simulated Hub, "export serve code" and "paste code into Hub" controls, matching steps 1 to 5 in `specs/005-bluetooth-transport/quickstart.md` section 2
- [X] T048 [US1] Implement Hub owner screens as native Web Components in `packages/hub-ui/src/`: `<hub-status>` (name, fingerprint shown as groups and as four words; a QR code is deferred because it needs a library, bridge state with the platform message for `peripheral-role-unsupported`, `bluetooth-off`, `permission-denied`), `<hub-spaces>` (list, add serve code by paste or QR scan, remove with "delete stored packets" confirmation), `<hub-clients>` (connected clients and state); jsdom tests in `packages/hub-ui/tests/`

### Android Hub (needs real hardware for the matrix)

- [ ] T049 [US1] Scaffold `hubs/android` (Capacitor 6+, Gradle) with a web shell `hubs/android/src/main.ts` that loads `@sync/hub-core` and `@sync/hub-ui`, persists Hub state through a Capacitor filesystem adapter, and shows a first-run screen explaining permissions and battery optimization
- [ ] T050 [US1] Implement the Kotlin Capacitor plugin `hubs/android/android/app/src/main/java/app/sync/hub/HubBlePlugin.kt` implementing `BleBridge` peripheral methods per `specs/005-bluetooth-transport/contracts/hub-ble-bridge.md` using `BluetoothGattServer` and `BluetoothLeAdvertiser`: service UUID in the advertisement, display name in the scan response, `TX` write events unmerged, `RX` notifications queued with backpressure and never above `mtu - 3`, MTU events, `maxConnections`, runtime permissions `BLUETOOTH_ADVERTISE`, `BLUETOOTH_CONNECT`, `BLUETOOTH_SCAN` on Android 12+, `support()` returning coded reasons (depends on T049)
- [ ] T051 [US1] Implement the Android foreground service and notification in `hubs/android/android/app/src/main/java/app/sync/hub/HubService.kt` keeping the Hub running with the screen off, optional wake lock setting, and the battery-optimization exemption prompt, so FR-008 unattended operation holds within platform limits (depends on T050)
- [ ] T052 [US1] **MANUAL, hardware.** Run `bleBridgeContract()` against the Android plugin through an instrumented test in `hubs/android/android/app/src/androidTest/java/app/sync/hub/BridgeContractTest.kt` (driving the shared contract through a small JS test bridge), record results in `specs/005-bluetooth-transport/validation.md` (depends on T050)

### Desktop Hub (each OS waits for its spike)

- [ ] T053 [US1] Scaffold `hubs/desktop` (Electron): main process hosts `@sync/hub-core`, a window loads `@sync/hub-ui`, a tray icon, a "keep awake while Hub runs" option, bridge selection by OS in `hubs/desktop/src/bridges/index.ts`, persistent data directory per OS, and Hub key storage in the platform keystore with an encrypted-file fallback (depends on T045, T048)
- [ ] T054 [US1] Implement the JSON-lines sidecar client in `hubs/desktop/src/bridges/sidecarBridge.ts` per the protocol in `specs/005-bluetooth-transport/contracts/hub-ble-bridge.md` (one JSON object per line, base64 binary, `{id, op, ...}` requests, `{id, ok}` replies, unsolicited `{event, ...}` lines, first line `{event:"hello", bridge, version:1}`, lines over 8 KiB are a protocol error, sidecar exits when stdin closes) with tests against a fake sidecar in `hubs/desktop/tests/sidecarBridge.test.ts`
- [ ] T055 [P] [US1] Implement the Linux bridge `hubs/desktop/src/bridges/bluezBridge.ts` with `dbus-next` using `org.bluez.GattManager1`, `org.bluez.LEAdvertisingManager1` and `org.bluez.Device1` (peripheral methods), reporting `bluetooth-off`, `no-adapter`, `permission-denied` codes (depends on T053, T008)
- [ ] T056 [P] [US1] Implement the macOS Swift sidecar `hubs/desktop/sidecar-macos/` (`CBPeripheralManager`; Bluetooth permission prompt handled; advertising name truncation reported) speaking the sidecar protocol (depends on T054, T008)
- [ ] T057 [P] [US1] Implement the Windows C# (.NET 8, WinRT) sidecar `hubs/desktop/sidecar-windows/` using `GattServiceProvider`; `support()` checks `BluetoothAdapter.IsPeripheralRoleSupported` and returns `peripheral-role-unsupported` (the Hub then shows "this computer's Bluetooth adapter cannot act as a Hub", RK-1) (depends on T054, T008)
- [ ] T058 [US1] **MANUAL, hardware** (gated by env `HUB_BLE_HARDWARE=1`). Run `bleBridgeContract()` against each desktop bridge in `hubs/desktop/tests/bridge.contract.test.ts` and record results per OS in `specs/005-bluetooth-transport/validation.md` (depends on T055, T056, T057)

**Checkpoint**: US1 works in simulation in CI and on real Android and desktop Hubs per the matrix. This is the MVP.

---

## Phase 4: User Story 2 - Discover and Choose Nearby Peers Safely (Priority: P1)

**Goal**: Clients see Hubs and connect only to Hubs that serve a Space they share; strangers learn nothing; the owner controls access.

**Independent Test**: A Hub and three clients (two in the Space, one not): the outsider receives nothing and learns nothing (SC-004); approval mode holds new clients until approved.

### Tests for User Story 2 (write first, confirm they FAIL)

- [X] T059 [P] [US2] `packages/hub-core/tests/access/not-served.test.ts`: an unknown Space and a wrongly proven Space produce the identical `rejected` entry; unauthenticated peers receive no Space, packet, or client information beyond `INFO`; the Hub store passes `plaintextScan` with no plaintext found and the Hub holds no content keys in every scenario (SC-004)
- [X] T060 [P] [US2] `packages/hub-core/tests/adversarial/link.test.ts`: replayed proof to a second session or Hub fails, wrong epoch fails, tampered nonce fails, `claim` for an already registered Space fails, oversized `auth` rejected, any message other than `auth` before `auth-ok` counts a strike, handshake flood limited to 6 per minute per device and 30 per minute overall (extra answered with `busy`), 3 strikes within 10 minutes disconnect and block for 15 minutes
- [X] T061 [P] [US2] `packages/transport-bluetooth/tests/trust.test.ts`: first contact requires `confirmHub` and pins the key; a known Hub presenting a different key aborts with `hub-identity-changed` and emits `identity-changed`; `forgetHub` removes the pin and permission so the next contact asks again
- [X] T062 [P] [US2] `packages/hub-core/tests/approval.test.ts`: in `approval` mode an unknown client gets `pending` and nothing is exchanged until `approve`; `deny` gives `reject: denied`; `pending` times out after 10 minutes; switching modes never revokes existing `trusted` records; in `open` mode a membership-proven client syncs with no approval step
- [X] T063 [P] [US2] `packages/hub-core/tests/access/autoSpaces.test.ts`: with `autoSpaces` off a Space the owner did not add is rejected with `not-served` and the message tells the owner nothing about what the Hub stores; with it on, the first access public key presented for a Space is registered (trust on first use) within at most 20 auto Spaces and 25% of storage each; auto Spaces are flagged in `spaces()` and removable; a second client presenting a different key for that Space is rejected
- [ ] T064 [P] [US2] Extend `tests/e2e/bluetooth-sim.spec.ts` with a three-client scenario (two members, one stranger) and with the approval-mode flow, asserting the stranger's UI shows only "not served" and the owner UI shows the approval prompt

### Implementation for User Story 2

- [X] T065 [US2] Implement pinning and first-use confirmation in `packages/transport-bluetooth/src/clientLink.ts` and `packages/transport-bluetooth/src/index.ts`: call `confirmHub(HubCandidate)` with the Hub name and fingerprint, pin `TrustedHubRecord` on yes, enforce key equality on later contacts, implement `trustedHubs()`, `forgetHub()`, `setAutoReconnect()` (depends on T061, T033)
- [X] T066 [US2] Implement `ClientRecord` handling in `packages/hub-core/src/clients.ts`: states `unknown → pending → trusted | blocked`; `trusted` automatically in open mode after a verified proof; `strikes` integer with 3 within 10 minutes setting `blockedUntil` to 15 minutes later; owner `block` permanent until `unblock`; persisted through `HubStore.putClient` (depends on T045)
- [X] T067 [US2] Implement approval mode in `packages/hub-core/src/link/server.ts` and `packages/hub-core/src/hub.ts`: `pending` control message, 10 minute pending timeout, `approve`/`deny`/`block`/`unblock`/`disconnect` in `HubControl`, `approval-needed` event, `INFO.mode` updated (depends on T066, T062)
- [X] T068 [US2] Implement automatic Space mode in `packages/hub-core/src/access/autoSpaces.ts`: `claim: [{space, epoch, accessPublicKey}]` accepted only when no key is registered for that Space AND the accompanying `sig` verifies under the claimed key, caps at most 20 auto Spaces and 25% of storage each by default, `space-added` event with `auto: true`, owner list flag and removal (depends on T032, T063)
- [X] T069 [US2] Implement abuse limits in `packages/hub-core/src/link/limits.ts` exactly per the table in `specs/005-bluetooth-transport/contracts/bluetooth-link.md` (concurrent clients, 6 handshakes per minute per device, 30 per minute overall, 3 strikes within 10 minutes, 20 s unauthenticated lifetime, only `auth` before `auth-ok`) and wire into the link server (depends on T060)
- [X] T070 [US2] Extend `packages/hub-ui/src/` with approval prompts, the clients list with block/unblock/disconnect, the mode toggle (open/approval), the automatic-Spaces toggle and the auto-Space list with removal; jsdom tests in `packages/hub-ui/tests/`
- [X] T071 [P] [US2] Implement `<sync-hub-confirm>` and a "Hub identity changed" warning in `packages/transport-bluetooth/src/ui/hub-confirm.ts` showing name, fingerprint groups, and the 4-word form, requiring an explicit user action; jsdom test in `packages/transport-bluetooth/tests/ui/hub-confirm.test.ts`
- [X] T072 [P] [US2] Implement `<sync-hub-code>` in `packages/transport-bluetooth/src/ui/hub-code.ts` to export a serve code as QR and as text through `exportHubCode`, with a separate "link code" option that shows the warning: "This code lets a Hub join other Hubs for this Space. It cannot read your data. Only give it to Hubs you own."; test in `packages/transport-bluetooth/tests/ui/hub-code.test.ts`

**Checkpoint**: US1 and US2 pass together; strangers learn nothing; owner controls work.

---

## Phase 5: User Story 3 - Resume and Survive Dropouts (Priority: P2)

**Goal**: Interrupted syncs resume by exchanging only what is missing; trusted Hubs reconnect without re-pairing.

**Independent Test**: Interrupt a large sync midway and reconnect: no delivered packet is re-sent and the end state matches an uninterrupted run (SC-003).

### Tests for User Story 3 (write first, confirm they FAIL)

- [X] T073 [P] [US3] `packages/transport-bluetooth/tests/property/loss.property.test.ts`: random frame loss and duplication never deliver a corrupted message; a partial message is discarded and later re-requested by the sync layer without affecting other messages (spec US3 scenario 3)
- [X] T074 [P] [US3] `packages/hub-core/tests/integration/resume.test.ts`: interrupt a 1,000-packet sync at a random point, reconnect, 0 previously delivered packets are re-sent (SC-003) and the final state equals an uninterrupted sync
- [X] T075 [P] [US3] `packages/transport-bluetooth/tests/reconnect.test.ts`: a trusted Hub back in range reconnects without the chooser through `getDevices()`/`watchAdvertisements()`; where unavailable `reconnect()` rejects with `needs-gesture` and the panel offers a one-tap button; `autoReconnect: false` never reconnects on its own
- [X] T076 [P] [US3] `packages/hub-core/tests/integration/late-client.test.ts`: a client that was offline while others edited receives everything the Hub stored for it on reconnect (spec US3 scenario 3)

### Implementation for User Story 3

- [X] T077 [US3] Implement the reconnect policy in `packages/transport-bluetooth/src/clientLink.ts`: exponential backoff with jitter, honoring `busy.retryMs`, halve `frameBytes` on write error (floor 20) and retry the frame, 15 s keepalive with 3 missed closing the link, never give up the connection for a size error alone (depends on T073)
- [X] T078 [US3] Implement `getDevices()`/`watchAdvertisements()` reconnection and the `needs-gesture` fallback in `packages/transport-bluetooth/src/webBluetooth.ts` and `reconnect(fingerprint)` in `packages/transport-bluetooth/src/index.ts`; the panel shows a one-tap reconnect where needed (depends on T075, T011)
- [X] T079 [US3] In `packages/hub-core/src/link/server.ts`: drop session keys immediately on disconnect, close the older connection when the same device connects twice (one logical connection per device), and make the Hub emit exactly one `client-disconnected` per connection (depends on T074)
- [X] T080 [US3] Expose `pendingOut`/`pendingIn` per Hub connection from the sync summaries in `packages/transport-bluetooth/src/index.ts` and surface them in the panel; state transitions `syncing ↔ idle` driven by matching summaries (FR-028)

**Checkpoint**: Dropouts and reconnects are boring.

---

## Phase 6: User Story 4 - Hub Stores and Forwards for Everyone (Priority: P2)

**Goal**: A client that leaves still delivers its changes to clients that connect later; Hubs sync with each other; the Hub relays to other transports.

**Independent Test**: Client A writes and disconnects, client B connects later and receives A's changes; Hub restarts without data loss; two Hubs connect and their clients converge (SC-006, SC-011).

### Tests for User Story 4 (write first, confirm they FAIL)

- [ ] T081 [P] [US4] `packages/hub-core/tests/store.segment.test.ts`: the segment store passes `hubStoreContract()`; a torn last record after a simulated crash is discarded on reopen with earlier records intact; an unknown segment format version is refused and never rewritten
- [ ] T082 [P] [US4] `packages/hub-core/tests/retention.test.ts`: default retention is 14 days; expired day shards are deleted whole; under storage pressure packets with `deliveredCount >= 1` are evicted before undelivered ones; evicting an undelivered packet emits `storage-warning { level: 'evicting-undelivered' }`; changing `retentionDays` or `storageLimitBytes` takes effect on the next enforcement
- [ ] T083 [P] [US4] `packages/hub-core/tests/integration/store-forward.test.ts`: A writes and disconnects, B connects 10 minutes later and receives A's packets (spec US4 scenario 1, SC-006); a Hub restart in between loses nothing; every packet applied exactly once with no loops (scenario 2); a client returning after the retention period is told the missing changes must come from another device or Hub (edge case)
- [ ] T084 [P] [US4] `packages/hub-core/tests/integration/hub-to-hub.test.ts`: two Hubs holding a link code for the same Space and `MemoryBleLink` central/peripheral roles connect, sync, and their clients converge (spec US4 scenario 3, SC-011); the Hub with the lower fingerprint initiates and only one logical link results; a Hub with a serve code only (no `accessSecret`) never initiates a Hub link; link code import shows the warning
- [ ] T085 [P] [US4] `packages/hub-core/tests/integration/relay-transports.test.ts`: a Hub with a WebSocket transport attached relays packets between Bluetooth clients and the relay server subject to `admit`, per-Space relay settings and without loops (spec US4 scenario 4)

### Implementation for User Story 4

- [ ] T086 [US4] Implement `packages/hub-core/src/store/segmentStore.ts`: per-Space, day-sharded (`YYYYMMDD`) append-only segment files with a versioned header plus an index (packet ID to segment offset, `deliveredCount`, `receivedAt`), packets stored as the original bytes, crash-safe (a torn last record is discarded on open), all file access through an injected `FsPort` so Android uses its filesystem adapter and desktop uses Node `fs` (depends on T081, T030)
- [ ] T087 [P] [US4] Implement the `FsPort` adapters: `hubs/desktop/src/fsNode.ts` (Node `fs`) and `hubs/android/src/fsCapacitor.ts` (Capacitor Filesystem), each passing a shared `fsPortContract` in `packages/hub-core/tests/fsPort.contract.ts` (atomic replace of the settings file, append, read ranges, list, delete)
- [ ] T088 [US4] Implement `packages/hub-core/src/retention.ts` calling `HubStore.enforce({now, retentionDays, limitBytes})` at start, hourly, and after each add; emits `storage-warning` at 90% of the limit and when evicting undelivered packets; expires old access keys per T032 (depends on T082, T086)
- [ ] T089 [US4] Track `deliveredCount` from the peers' acknowledged summaries (`markDelivered` for packets held by at least one peer other than the origin) in `packages/hub-core/src/hub.ts` (depends on T086)
- [ ] T090 [US4] Implement Hub-to-Hub linking in `packages/hub-core/src/hubToHub.ts`: scan through the bridge central role, connect only when both Hubs hold a link code for a shared Space, run the client handshake using the code's `accessSecret`, initiator is the Hub with the lower fingerprint, one logical link per Hub pair, sync with `relay` on; settings flag `hubToHub` (default true when any link code is held) (depends on T084, T044)
- [ ] T091 [P] [US4] Add the central-role methods (`startScan`, `stopScan`, `connect`, `write`, and the `seen`/`notify` events) to each bridge per `specs/005-bluetooth-transport/contracts/hub-ble-bridge.md`: Android `HubBlePlugin.kt` (`BluetoothGatt`), `hubs/desktop/src/bridges/bluezBridge.ts` (`Device1`), the macOS sidecar (`CBCentralManager`), the Windows sidecar (`BluetoothLEAdvertisementWatcher`, `BluetoothLEDevice`); extend `bleBridgeContract()` and `MockBleBridge` with the central cases
- [ ] T092 [US4] Allow a Hub to attach other transports (WebSocket) through `HubOptions.transports` in `packages/hub-core/src/hub.ts` with relay rules per Space (depends on T085)
- [ ] T093 [US4] Extend `packages/hub-ui/src/` with a storage screen (usage per Space, oldest packet, retention days "1 to 365", storage limit), the link-code import warning, Hub-to-Hub status, and Space removal with the "delete stored packets" choice; client-side message in `packages/transport-bluetooth/src/ui/bluetooth-panel.ts` for the "retention passed" case

**Checkpoint**: Hubs behave as a durable, bounded relay and link to each other.

---

## Phase 7: User Story 5 - Sync Larger Content Locally (Priority: P3)

**Goal**: Blobs move over the Bluetooth link at a fair share, with progress, resumption, and a clear "waits for a faster transport" message for very large files.

**Independent Test**: Attach a blob on client A, client B receives it via the Hub verified, with progress shown, and resumes after an interruption; a 20 MiB blob waits for a faster transport.

### Tests for User Story 5 (write first, confirm they FAIL)

- [ ] T094 [P] [US5] `packages/transport-bluetooth/tests/link/fairness.test.ts`: under a continuous stream-1 flood, stream-0 frames are sent at least once per 4 stream-1 frames and packet latency p95 stays at most 2x idle in the simulator
- [ ] T095 [P] [US5] `packages/hub-core/tests/integration/blob-over-bluetooth.test.ts`: a blob attached on A reaches B through the Hub with manifest, chunk, tag and size verified (spec 004 rules), progress events emitted, and resumes after an interruption requesting only missing chunks; the Hub's `BlobRelay` stores ciphertext only
- [ ] T096 [P] [US5] `packages/transport-bluetooth/tests/blob-ceiling.test.ts`: a 20 MiB blob with the default 5 MiB ceiling is not auto-transferred over Bluetooth, the user is told it waits for a faster transport, and it transfers automatically once a faster transport connects (spec US5 scenario 3); the ceiling is configurable per app through `blobCeilingBytes`

### Implementation for User Story 5

- [ ] T097 [US5] Map lane messages (first byte a registered lane magic such as `0xB1`) to stream 1 in `packages/transport-bluetooth/src/clientLink.ts` and `packages/hub-core/src/link/server.ts`; confirm `laneContract()` still passes (depends on T094)
- [ ] T098 [US5] Implement `blobCeilingBytes` (default 5 MiB, per spec research R-05) in `packages/transport-bluetooth/src/index.ts`; wire it into the `@sync/blobs` policy module in `packages/blobs/src/policy/` as an additive, non-breaking per-transport ceiling option (look up the existing policy API first and extend it rather than adding a new path) with a unit test in `packages/blobs/tests/unit/transport-ceiling.test.ts` (depends on T096)
- [ ] T099 [US5] Wire `BlobRelay` and `createFileBlobStorage` into `packages/hub-core/src/hub.ts` through `HubOptions.blobDir`, with the Hub-level storage limit and per-Space caps applied to blobs too, TTL/LRU from the existing relay options (depends on T095, T088)
- [ ] T100 [US5] Show blob transfer progress and the "waits for a faster transport" message in `packages/transport-bluetooth/src/ui/bluetooth-panel.ts` using the progress events from `@sync/blobs`; jsdom test in `packages/transport-bluetooth/tests/ui/bluetooth-panel.blob.test.ts`

**Checkpoint**: All five user stories pass.

---

## Phase 8: Polish & Cross-Cutting Concerns

- [ ] T101 [P] Compatibility tests in `packages/transport-bluetooth/tests/link/compat.test.ts` and `packages/hub-core/tests/compat.test.ts`: unknown control `t` values and unknown fields are ignored; reserved frame bits are sent as 0 and ignored on receipt; non-overlapping `INFO.v` ranges produce "update needed" without further connection; link minor mismatch negotiates down; segment store with unknown version refused
- [ ] T102 [P] Benchmarks `packages/transport-bluetooth/bench/link.bench.ts`: a 1,000-object Space (about 1 MiB) first sync at simulated 20 KB/s (goal under 2 minutes) and 100 KB/s (goal under 30 s), packet latency during a blob stream, link CPU overhead; record in `specs/005-bluetooth-transport/validation.md`
- [ ] T103 [P] Write `specs/005-bluetooth-transport/security-review.md` (format of `specs/004-blob-sync/security-review.md`): threats radio eavesdropper, rogue Hub, nearby stranger, removed member (RK-2), automatic-mode squatting (RK-3), resource exhaustion, malicious client data, sidecar compromise; map each to a test; confirm the Hub holds no content keys (SC-004) and that the link-code `accessSecret` cannot decrypt anything
- [ ] T104 [P] Accessibility pass on all new Web Components in `packages/transport-bluetooth/src/ui/` and `packages/hub-ui/src/`: labels, keyboard operation, focus order, status announcements (`aria-live`) for connection state, text alternatives for QR codes (the code text is always available)
- [ ] T105 [P] Write `docs/bluetooth.md` (how to get and run a Hub, serve codes, open vs approval mode, automatic Spaces, retention, supported browsers and platforms, troubleshooting) and READMEs for `packages/transport-bluetooth`, `packages/hub-core`, `packages/hub-ui`, `hubs/desktop`, `hubs/android`; link from the root `README.md`
- [ ] T106 **MANUAL, hardware.** 8-hour soak script `hubs/tools/soak.mjs` and run: 8 clients taking turns connecting and disconnecting against one Hub; 0 undelivered packets lost (SC-009); record battery and resource use in `specs/005-bluetooth-transport/validation.md`
- [ ] T107 **MANUAL, hardware.** Run the real-device matrix rows 1 to 10 in `specs/005-bluetooth-transport/quickstart.md` section 3 and record each result with device, OS and browser in `specs/005-bluetooth-transport/validation.md`; map each Success Criterion SC-001 to SC-011 to its evidence
- [ ] T108 Run `npm run typecheck`, `npm run lint`, `npm run build`, `npm test`, `npm run test:bluetooth`, `npm run test:hub`, the Playwright suite `npm run e2e`, and confirm the existing 001 to 004 suites are unchanged and green (depends on all previous implementation tasks)
- [ ] T109 Update `specs/005-bluetooth-transport/plan.md` (Constitution Check, Risks, any spike-driven changes), `specs/005-bluetooth-transport/spec.md` status to Implemented, and the Sync Impact notes in `.specify/memory/constitution.md` only if a principle needed interpretation (do not amend principles without the governance process)


---

## Dependencies & Execution Order

### Phase dependencies

- **Phase 1 Setup**: no dependencies. The four spikes (T008 to T011) can start immediately and run in parallel with Phase 2.
- **Phase 2 Foundational**: depends on Setup (not on the spikes); BLOCKS all user stories.
- **US1 (P1)**: depends on Phase 2. Hub shells depend on their spike: T055, T056 and T057 wait for T008; T078 (US3) waits for T011.
- **US2 (P1)**: depends on US1 (link server, client link, Hub core).
- **US3 (P2)**: depends on the US1 transport and link; independent of US2 and US4.
- **US4 (P2)**: depends on the US1 Hub core; the central-role bridge work (T091) also needs the US1 bridges.
- **US5 (P3)**: depends on the US1 link and Hub core, and on spec 004 code; independent of US2 to US4.
- **Phase 8 Polish**: depends on the stories you ship.

### Within a story

Tests (confirm they fail) then implementation; shared codecs before the client and Hub code that use them; Hub core before native shells; client panel after the transport. Contract suites run against every implementation of the contract they cover.

### Key task dependencies

- T013 (access derivation) feeds T015, T016, T032, and every US2 test.
- T018 feeds T020 and T022, which feed T040 and T044.
- T028 (relay amendment) feeds T044 and T045.
- T045 feeds T053, T066 and the Hub integration tests.
- T086 feeds T088, T089 and T099.

---

## Parallel Execution Examples

**Phase 2, test-first batch (all different files)**: T012, T014, T017, T019, T021, T023, T025, T026, T027.

**US1 test batch**: T035, T036, T037, T038.

**US1 native shells (after Hub core, in parallel by platform)**: T049 (then T050, T051) alongside T055, T056, T057.

**US2 test batch**: T059, T060, T061, T062, T063, T064.

**US3 and US5 can be developed in parallel by different people** once US1 is done: US3 touches reconnect policy and counters; US5 touches lane mapping, the blob ceiling and the Hub blob wiring.

---

## Implementation Strategy

### MVP first (US1 only)

1. Phase 1 Setup, start the spikes.
2. Phase 2 Foundational (simulator, link codec, access, relay amendment).
3. Phase 3 US1 with the simulated radio: transport, Hub core, owner UI, demo.
4. **STOP and validate** in simulation: `npm run test:bluetooth`, `npm run test:hub`, the Playwright demo.
5. Then the Android Hub (T049 to T052) and one desktop OS, per spike results, and run matrix rows 1 and 2.

### Incremental delivery

- Add US2 (safe discovery, approval, automatic mode) before any real-world distribution: this is the story that makes the radio safe to expose.
- Add US3, then US4 (durable Hub, Hub-to-Hub), then US5 (blobs).
- Phase 8 gates a release: security review, soak, hardware matrix, compatibility tests.

### Risk notes

- If spike S-1 fails for an OS, defer that desktop shell and ship Android plus the OS that passed; document the unsupported OS in `docs/bluetooth.md`. The `BleBridge` contract keeps the rest unchanged.
- If spike S-2 shows 20-byte frames on a pairing, record real throughput and decide whether the 5 MiB blob ceiling must drop; no code change is needed to lower it.
- If spike S-4 shows `getDevices()` missing, the one-tap reconnect button is the reconnect path; no task is removed.
