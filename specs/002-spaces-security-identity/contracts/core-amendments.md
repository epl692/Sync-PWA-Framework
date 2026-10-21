# Contract: Amendments to Spec 001 Core

Spec 001 is implemented. The items below are additive changes to `@sync/core` that this feature needs. Each is backward compatible (new optional hooks), and each carries a compatibility note as the constitution requires. They are delivered first (Phase A in the plan), with tests, before any spaces code.

| ID | Name | Why | Compatibility |
|---|---|---|---|
| **A-1** | `PacketSigner` extension point | The write path builds the envelope with `sig: null` and never signs | Optional. With no signer registered, behavior is unchanged (`sig: null`). Order on send: encode → build envelope → **sign** → send validators → apply |
| **A-2** | `rebuildSpace(space)` | Authority can change retroactively; merge cannot un-apply | New method. Not called by 001 code paths |
| **A-3** | Sealed + signed snapshots (`SnapshotSealer`, `SnapshotValidator`) | Snapshots are plaintext and unsigned (research R-11) | Optional hooks. Without them, snapshots work as in 001 (dev/test only; release gate in the plan requires them) |
| **A-4** | Plugin message channel `core.channel(name)` and relay forwarding | Join/link handshakes are not packets (the joiner is not a member) and must work through the relay | New unknown-`t` messages are already ignored by 001 peers ("Unknown `t` values are ignored"). Relay forwards channel messages to other peers that share the declared Space |
| **A-5** | Queries hide `$`-prefixed types unless asked by exact type | Control objects must not appear in app queries | Behavior change only for types starting with `$`, which 001 never produced |
| **A-6** | `CompactionPolicy.pin(type)` | `$sys.*` events and keygrants must never be compacted (fold must be reproducible) | Optional; default pins nothing |
| **A-7** | Validator context carries `peer?: PeerId` and a `parkedLimit` | DoS bound on deferred packets from unknown authors | Added optional fields; limit default `maxParkedPerAuthor = 1000` |

## A-1 PacketSigner

```ts
export interface PacketSigner {
  readonly id: string;                 // "ed25519/1"
  sign(envelopeWithNullSig: Uint8Array /* canonical bytes */, ctx: { space: string; author: string }): Promise<Uint8Array>;
}
// ExtensionRegistry gains: registerSigner(signer: PacketSigner): void;
```

The core passes the canonical bytes (001 canonical encoding) and stores the returned 64 bytes in `sig`. The core never interprets `sig`.

## A-2 rebuildSpace

```ts
rebuildSpace(space: SpaceId): Promise<{ reapplied: number; rejected: number }>;
```

Clears derived state (`objects`, `summary` stay) for the Space, then re-runs the apply pipeline over retained packets in clock order. Packets that now fail validation are marked `rejected` in the log (kept, never applied, never relayed). Snapshot-covered ranges are not replayed (see research R-10 limit).

## A-3 Sealed and signed snapshots

```ts
export interface SnapshotSealer {
  seal(space: string, scope: string, objects: unknown[]): Promise<Uint8Array>;
  open(space: string, bytes: Uint8Array): Promise<{ ok: true; scope: string; objects: unknown[] } | { ok: false; reason: 'missing-key' | 'malformed' }>;
}
export interface SnapshotValidator {
  validate(space: string, signer: string | undefined, canonical: Uint8Array, sig: Uint8Array | undefined): Promise<{ accept: boolean; reason?: string }>;
}
```

Wire change to the `snapshot` message (additive): `objects` is replaced by `sealed: base64url[]` (one per scope per part) when a sealer is registered; `signer` and `sig` are added. Receivers without a sealer ignore the new fields and fail to read `objects`, so they **discard** the snapshot (reported, not applied) and catch up by packets. No corruption results.

## A-4 Channel

```ts
core.channel(name: string): {
  send(peerId: PeerId, payload: Uint8Array): Promise<void>;
  onMessage(handler: (peerId: PeerId, payload: Uint8Array) => void): () => void;
  /** Spaces this device advertises for the relay to route by (opaque space IDs only). */
  setRoutes(spaces: string[]): void;
};
```

Wire: `{ "t": "chan", "name": "identity/1", "space": "<spaceId or *>", "payload": "<base64url>" }`. The relay (RelayHub) forwards `chan` messages to the other connected peers whose `hello.spaces` include the Space, without storing them. Size limit is `limits.maxMessageBytes`. Channel messages are never persisted by the core.

## Required tests for the amendments (written first)

- A-1: a registered signer's output appears in `sig` for local writes; an unsigned core is unchanged.
- A-2: after `rebuildSpace`, `stateHash` equals the hash computed by a peer that received the same packets in the order that makes them valid; a retroactively invalid packet is no longer visible.
- A-3: a snapshot over a recording transport contains no plaintext marker; a snapshot with a bad signature is discarded and reported.
- A-4: a relay forwards `chan` between two clients and stores nothing of it.
- A-5/A-6: a `$sys.x` object is absent from `query({})`, present for `query({type: '$sys.x'})`, and survives `compact()`.
