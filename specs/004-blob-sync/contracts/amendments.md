# Contract: Amendments to Existing Packages

Specs 001–003 are implemented. This feature needs the small, additive changes below. Each is backward compatible (new optional hooks and fields; nothing existing changes behavior), is delivered **first** (Phase A in the plan) with tests, and carries a compatibility note as the constitution requires.

| ID | Package | Change | Why |
|---|---|---|---|
| **B-1** | `@sync/core` | Binary lane: `core.lane(magic)` plus `hello.lanes` | Bulk bytes must not share the JSON packet queue or be base64-wrapped (research R-01) |
| **B-2** | `@sync/core` | Extend the existing `PeerSummary` / `core.peers()` with `spaces`, `relay`, `maxMessageBytes`, `bulk`, and add `peer:ready` / `peer:gone` events | The scheduler picks peers by shared Space |
| **B-3** | `@sync/core` | `onApplied` events carry the post-apply `object` | The reference index must follow object state, not packet bodies |
| **S-1** | `@sync/spaces` | `blobKeys`: derive blob keys for a scope and epoch | The blob engine must never see raw epoch keys |
| **M-1** | `@sync/modules` | `blob` field type and an optional `ctx.blobs` facade | Validation of references and access control (research R-11, R-12) |
| **R-1** | `@sync/relay-server` | `BlobRelay` plugged into `RelayHub`'s lane hook | Relay stores ciphertext blobs (spec US2.4) |
| **T-1** | `@sync/testkit` | `laneContract()`, `blobStorageContract()`, blob peer harness | Principle VIII |

## B-1: Binary lane

```ts
// @sync/core (additive)
interface Lane {
  readonly magic: number;                               // 0x80..0xFF; 0xB1 = blob lane
  peers(): LanePeer[];                                  // connected peers that advertised this lane
  send(peerKey: string, bytes: Uint8Array): Promise<void>; // bytes MUST start with `magic`; goes straight to Transport.send
  onMessage(handler: (peerKey: string, bytes: Uint8Array) => void): () => void;
  onPeer(handler: (e: { type: 'up' | 'down'; peer: LanePeer }) => void): () => void;
}
type LanePeer = PeerSummary & { spaces: string[]; relay: boolean; maxMessageBytes: number; bulk: boolean }; // PeerSummary (key, transport, peerId, label?) already exists in @sync/core
core.lane(magic: number): Lane;                         // registering twice with one magic throws
```

- **Wire**: a message whose first byte is a registered lane magic is routed to that lane's handlers and never reaches the JSON decoder (JSON messages begin with `{` = 0x7B; lane magics are ≥ 0x80). Sync `hello` gains the optional field `lanes: number[]` listing registered magics. A lane peer is one whose `hello.lanes` contains the magic.
- **No head-of-line coupling**: lane sends do not use the session's packet queue (`Session.enqueue`); they call the transport's `send` directly. The transport's own ordering and backpressure still apply.
- **`spaces`/`relay`** come from the peer's `hello` (wildcard Spaces from a relay are reported as `["*"]`); `peers()` updates when the peer announces a new Space. **`bulk`** is the transport's `capabilities.blobs`.
- **Unregistered magic**: dropped and counted in telemetry, never fatal.
- **Order (as built)**: an inbound lane message is delivered after everything that peer sent before it has been handled (so its `hello`, which names its lanes, is processed first), without joining the queue: later sync messages never wait for the lane handler. A lane registered after a peer connected treats peers that already advertised it as up, so their disconnect is reported.
- **Size limit**: the lane router enforces `limits.maxMessageBytes` (default 4 MiB) on each message as delivered by the transport, after any transport framing; an oversize message is dropped and reported and the connection stays open. The sync decoder's own check does not run for lane messages.
- **Compatibility**: a 001/002 peer ignores the unknown `hello.lanes` field and is never sent a lane message (it is not in `peers()`). A lane message that reaches a peer without the lane (for example a relay that does not know it) is dropped by the existing "malformed message is reported, connection stays open" rule. `Transport.blob` hooks remain declared in the 001 contract but unused and marked reserved.
- **Tests (first)**: lane round trip over memory, WebSocket and WebRTC transports; a 1 MiB binary message intact; lane traffic does not delay a packet beyond one chunk (timing test with fake clock); a peer without the lane is never sent lane bytes; an old-style peer receiving a stray lane byte stays connected; an oversize lane message is dropped and reported; messages above the transport's `maxMessageBytes` up to the core limit arrive intact (transport framing).

## B-2: Peer info

- `core.peers()` already exists and returns `PeerSummary { key, transport, peerId, label? }` (`packages/core/src/sync/channel.ts`, exported from `@sync/core`). This amendment extends `PeerSummary` additively with `spaces`, `relay`, `maxMessageBytes`, `bulk` (all from the peer's `hello` and the transport's capabilities) and adds `peer:ready` (after `hello`) and `peer:gone` to `CoreEvent`.
- **Compatibility**: new optional fields and event kinds; existing consumers ignore them.
- **Tests (first)**: peers carry the new fields; `peer:ready` fires after `hello`; `peer:gone` on disconnect; a relay's wildcard Space is `["*"]`; a newly announced Space updates the entry.

## B-3: `onApplied` carries the post-apply object

- `onApplied(cb: (e: { env, body, source, object?: SyncableObject }) => void)`: `object` is the object as it stands after the packet was applied (for a delete, the tombstoned object). It is set from the local `obj` at the existing emit point in `packages/core/src/store/apply.ts` (including the reapply path). Needed because `body.fields` holds only the packet's own fields, so for updates, last-writer-wins losers and nested values the reference index could not see current state from the packet alone.
- **Compatibility**: new optional property; no behavior change; consumers that ignore it are unaffected (002 spaces suites stay green).
- **Tests (first)**: create, update, a last-writer-wins-losing update (reports the current object, older value not applied), a parked packet applied later, and delete.

## S-1: Blob keys (spaces)

```ts
// @sync/spaces (additive)
interface BlobKeys {
  /** Scope for an object (Space or override share), same rule as packet encryption. */
  scopeFor(space: string, obj: string): string;
  /** Keys for writing: the scope's current epoch. Undefined if this device holds none. */
  forWrite(scope: string): Promise<{ scopeId: Uint8Array; epoch: number; keyId: string; enc: CryptoKey; mac: CryptoKey } | undefined>;
  /** Keys for reading a given `keyId`. Undefined if this device does not (yet) hold that epoch key. */
  forRead(scope: string, keyId: string): Promise<{ scopeId: Uint8Array; enc: CryptoKey; mac: CryptoKey } | undefined>;
  /** Fires when new epoch keys arrive, so `failed: no-key` blobs can be retried. */
  onKeysChanged(handler: (scope: string) => void): () => void;
}
spaces.blobKeys: BlobKeys;
```

- Derivation per [blob-format.md](./blob-format.md#keys), done inside the spaces package; derived `CryptoKey`s are non-extractable.
- Access rules: `forWrite`/`forRead` only return keys the device is entitled to; a removed device gets none for epochs it was never granted (002 grants).
- **Compatibility**: new read-only API over existing keystore data; no change to packets, grants, or counters.
- **Tests (first)**: KAT vectors for HKDF output; keys for a rotated epoch decrypt a blob written before rotation; a device never granted epoch N gets `undefined`; share scope gives share keys, not Space keys.

## M-1: Modules

- **`blob` field type** (schema language, 003 `schema.ts`): `{ type: 'blob'; required?: boolean; accept?: string[]; maxBytes?: number }`. Validates the reference per [data-model.md](../data-model.md#blob-reference-synced-inside-a-packet) (shape, ID format, `size ≤ min(maxBytes, configured max)`, media type matches `accept` patterns such as `image/*`). `checkSchema` accepts it; a list of blobs is `list` of `blob` (extends `of`). Migration and projection treat it as an opaque JSON value.
- **`ctx.blobs` facade** (optional service): `attach`, `request`, `open`, `observe`, `pin`, `unpin`, `cancel` with the same signatures as `Blobs`, each checking declared Space access (`AccessDeniedError`). Present only when the app config enables blobs.
- **Dependency direction**: `@sync/blobs` exports a pure subpath `@sync/blobs/ref` (`BlobRef`, `validateRef`, `extractRefs`; no crypto, no storage, no `@sync/core` or `@sync/spaces` imports). `@sync/modules` declares `@sync/blobs` as an optional peerDependency (`peerDependenciesMeta`) and imports only that subpath (plus `import type` of `Blobs` for the facade, the instance being injected through the app config). A release-surface test enforces this; modules keeps zero runtime `dependencies`.
- **As built**: the app enables blobs with `StartOptions.blobs`, a factory `({ core, spaces }) => Promise<Blobs>` called once the core is open (for example `createBlobs({ core, keys: spaces.blobKeys })`), so the engine is created by the app and `@sync/modules` never imports `@sync/blobs` at runtime. `ctx.blobs` exists for a module only when the engine is enabled and the module has at least one type it may read or write; `pin`/`unpin`/`cancel` need read access to the reference's Space, `attach` needs write access.
- **Compatibility**: older modules ignore both. Schemas without `blob` fields are unchanged. A newer schema using `blob` on an older host fails `checkSchema` with a clear "unknown field type" error at registration, never at runtime on data.
- **Tests (first)**: oracle comparison for `blob` validation (property); facade denies a Space not declared; list-of-blob works.

## R-1: Relay

- `RelayHub` gets `onLane(magic, handler)` and `sendLane(peerId, bytes)` (additive) and reports peers' declared Spaces to the handler. `BlobRelay` registers on `0xB1`, uses a Node `FileBlobStorage`, and applies caps: `maxBlobBytes`, `perSpaceBytes`, `totalBytes`, `ttlMs` (last access), optional `authorize(space, peerId)`. All default to generous values, nothing is enforced beyond configuration in v1 (spec Assumptions) except structural verification.
- The relay holds **no keys** and decodes nothing; SC-003 is checked by scanning stored files for known plaintext markers.
- **Compatibility**: a relay without `BlobRelay` simply does not advertise the lane; clients then use only peers that do.
- **Tests (first)**: relay verifies and rejects a manifest whose hash differs from the offered ID; rejects chunks failing their digest; enforces caps; evicts by TTL and LRU; survives restart with the on-disk store; plaintext scan.

## T-1: Testkit

`laneContract(factory)` (every Transport), `blobStorageContract(factory)` (memory, IndexedDB via fake-indexeddb, file system), `blobPeers()` harness (N devices, optional relay, memory transport with controllable latency, drop, reorder, and corruption), and a `tamper()` helper for property tests.

## Overall compatibility summary (required by Development Workflow)

- **Packet format, signing, 002 codec**: unchanged.
- **Transport contract**: unchanged interface; one new suite (`laneContract`) and one new advertised capability via `hello.lanes`.
- **Older peers**: continue to sync packets and store blob references as plain field values; they never receive blob bytes and cannot fetch attachments. Newer peers keep serving them nothing, harmlessly.
- **Mixed versions** are covered by a testkit scenario: a no-lane peer and a lane peer in one Space converge on packets while the lane pair transfers a blob.
