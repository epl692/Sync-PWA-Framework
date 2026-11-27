# Data Model: Bluetooth Local Transport

Entities from [spec.md](./spec.md), with fields, rules, and state. Nothing here is a Syncable Object: these are local, device-held records. Synced data stays packets and blobs (specs 001 to 004).

## Hub (Hub device, persisted by the Hub)

| Field | Type | Rules |
|---|---|---|
| `hubKey` | Ed25519 keypair | Created on first run. Private key never leaves the device. Identifies the Hub for link authentication |
| `fingerprint` | string | Short readable form of SHA-256(public hubKey), shown to users for first-use confirmation (8 groups of 4 base32 characters; also rendered as 4 words) |
| `displayName` | string, 1 to 32 chars | Owner-editable; default `Hub-XXXX` from the fingerprint |
| `accessMode` | `open` \| `approval` | Default `open` (spec FR-015) |
| `autoSpaces` | boolean | Default `false` (spec FR-012) |
| `maxClients` | integer | Default min(7, platform limit); at least 1 |
| `retentionDays` | integer | Default 14; 1 to 365 |
| `storageLimitBytes` | integer | Default 1 GiB packets+blobs, owner-editable |
| `perSpaceCapBytes` | integer | Default 25% of storage limit in automatic mode |
| `linkVersion` | `{min,max}` | Link protocol range this build supports |

## ServedSpace (per Hub)

| Field | Type | Rules |
|---|---|---|
| `space` | Space ID | Unique per Hub |
| `source` | `code` \| `auto` | How it was added |
| `accessKeys` | list of `{epoch, publicKey, addedAt, expiresAt?}` | Public keys that may prove membership. Old epochs get `expiresAt = replacedAt + retentionDays` |
| `accessSecret` | Ed25519 private key or none | Present only for a link code (R-07); used for Hub-to-Hub |
| `bytesStored` | integer | For caps and the owner screen |
| `addedAt` | timestamp | |

State: `active` -> `removed` (owner removes; stored packets deleted after confirmation).

## ClientRecord (per Hub)

| Field | Type | Rules |
|---|---|---|
| `deviceId` | device public key ID (spec 002) | Primary key |
| `name` | string | Display name supplied by the client app, untrusted |
| `state` | `unknown` -> `pending` -> `trusted` \| `blocked` | In open mode a membership-proven client goes straight to `trusted` for that session; the record is kept for the owner list |
| `spaces` | list of Space IDs | Spaces the client proved in its current or last session |
| `lastSeen` | timestamp | |
| `strikes` | integer | Invalid-data count; reaching 3 sets a temporary block (FR-026) |
| `blockedUntil` | timestamp or null | Default 15 minutes after strikes; owner `block` is permanent until removed |

State transitions:

- `unknown` -> `trusted` automatically when `accessMode = open` and a membership proof verifies.
- `unknown` -> `pending` when `accessMode = approval`; owner approve gives `trusted`, owner deny gives `blocked`.
- `trusted` -> `blocked` by owner, or temporarily by strikes.
- Switching to `approval` mode does **not** revoke existing `trusted` records; the owner can revoke each.

## TrustedHubRecord (client side, persisted in the app)

| Field | Type | Rules |
|---|---|---|
| `fingerprint` | string | Primary key; confirmed by the user on first use |
| `publicKey` | Ed25519 public key | Pinned. A different key for the same name triggers a "Hub identity changed" warning and blocks until the user confirms |
| `name` | string | Last seen name |
| `browserDeviceId` | opaque | Web Bluetooth device identity for `getDevices()` reconnection (not portable between browsers) |
| `autoReconnect` | boolean | User choice (FR-017) |
| `lastConnected` | timestamp | |

## HubConnection (runtime, both ends)

| Field | Type | Rules |
|---|---|---|
| `peerId` | string | Hub: `c:<clientDeviceId>`. Client: `hub:<fingerprint>` |
| `state` | `searching` \| `connecting` \| `securing` \| `authenticating` \| `pending` \| `syncing` \| `idle` \| `disconnected` \| `full` \| `error` | Mirrors spec FR-028 plus link steps |
| `frameBytes` | integer | Negotiated (R-03); 20 to 244 |
| `acceptedSpaces` | list of Space IDs | Narrow the sync `hello.spaces` |
| `pendingOut` / `pendingIn` | integers | Packets still to send or expected, from sync summaries |
| `session` | `{txKey, rxKey, txCounter, rxCounter}` | Memory only |

State transitions are in [contracts/bluetooth-link.md](./contracts/bluetooth-link.md#connection-state-machine).

## StoredPacketSet (Hub)

Per Space: packets exactly as received (original bytes, never re-encoded, per packet-envelope rule), keyed by packet ID.

| Field | Type | Rules |
|---|---|---|
| `id` | packet ID (`author:seq`) | Unique; duplicates ignored |
| `bytes` | bytes | Original envelope bytes |
| `receivedAt` | timestamp | Drives retention |
| `deliveredCount` | integer | Peers other than the origin that acknowledged holding it. Drives eviction order |
| `day` | `YYYYMMDD` | Segment shard |

Rules: expired day-shards are deleted whole. Under storage pressure, delete oldest with `deliveredCount >= 1` first; never delete a packet with `deliveredCount = 0` before all delivered ones are gone, and warn the owner when forced to (spec FR-009).

## ServeSpaceCode

Text form: `syncserve:1:` + base64url(JSON). See [contracts/hub-access.md](./contracts/hub-access.md). Fields: `space`, `epoch`, `accessPublicKey`, optional `accessSecret` (link code only), `name`, `createdAt`, optional `expiresAt`.

## FragmentedMessage (both ends, memory only)

| Field | Type | Rules |
|---|---|---|
| `stream` | 0 or 1 | |
| `bytes` | growing buffer | Limited to `maxMessageBytes` (512 KiB) plus 16 B tag; exceeding it aborts the message |
| `startedAt` | timestamp | 30 s timeout |
| `nextSeq` | 0..63 | A gap aborts the message |

## TransportStatus

`unsupported(reason)` \| `unavailable(reason)` \| `needs-hub` \| `needs-permission` \| `ready` \| `full`. Maps onto the 001 `TransportState` values as in [contracts/transport-bluetooth.ts](./contracts/transport-bluetooth.ts).
