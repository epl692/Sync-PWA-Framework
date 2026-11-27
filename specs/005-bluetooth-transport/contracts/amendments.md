# Amendments to existing packages, and compatibility summary

The Bluetooth transport and Hub are new packages. They need three small, additive changes to existing code. The packet envelope, signing, sync protocol messages, binary lane, and the `Transport` contract are **not** changed (the constitution requires a written note for any change touching these; this document is it).

## S-2: Spaces gets Hub access derivation (`packages/spaces`)

Adds `deriveHubAccess(epochKey, spaceId, epoch)`, `exportHubCode(space, opts)`, `proveHubChallenge(...)`, and a `HubProofProvider` adapter for the transport. The derivation label `"sync-hub-access/1"` is registered in `specs/002-spaces-security-identity/contracts/crypto-envelope.md`.

| Question | Answer |
|---|---|
| Wire change | None. No packet, grant, or key format changes |
| Older code | Ignores the new functions. Existing Spaces keep working; exporting a code works for any existing Space and epoch |
| Security | New key is domain-separated and one-way (see [hub-access.md](./hub-access.md)); added to the security review checklist |
| Tests | Known-answer vectors; property test that access keys never collide with other derived keys |

## R-2: RelayHub gets a store hook and an admission gate (`packages/relay-server`, extracted to `packages/hub-core`)

- `RelayHubOptions.store?: HubStoreLike` lets packets persist instead of living only in memory. Default stays the in-memory store, so the reference relay server is unchanged.
- `RelayHubOptions.admit?: (peerId, space) => boolean` is checked for every Space a peer declares, including when it sends the wildcard Space. A denied Space is dropped from that peer's effective `hello.spaces`. Default allows everything (current behavior).
- `RelayHub` is moved to `@sync/hub-core` and re-exported from `@sync/relay-server` so imports keep working.

| Question | Answer |
|---|---|
| Wire change | None. `hello` and `summary` are unchanged. A peer simply sees only the Spaces it was admitted to |
| Older peers | Unaffected: from their side the Hub is a relay that shares fewer Spaces |
| Tests | Existing `relayHub.test.ts` stays green; new tests for `admit` including wildcard, and for persistence round-trips and crash recovery |

## T-2: Testkit gains simulators and suites (`packages/testkit`)

Adds `MemoryBleLink` (simulated GATT with MTU, write limit, loss, duplication, latency, disconnect), `bleBridgeContract()`, `hubStoreContract()`, and Hub peers for convergence tests. No existing export changes.

## No changes to

- `Transport` contract (`specs/001-sync-core/contracts/transport.ts`). The Bluetooth transport uses it as is. `capabilities.blobs` is `false`; the blob module's per-transport ceiling is a configuration of the Bluetooth module (see R-05), not a contract change.
- Packet envelope, canonical encoding, signing, clock, or merge rules.
- Blob format and the binary lane. The lane is carried on stream 1 of the link.
- Module contract (spec 003): the transport registers as an ordinary module.

## Overall compatibility summary (required by Development Workflow)

| Pair | Behavior |
|---|---|
| Older client (no Bluetooth transport) with any Hub | Never connects. No effect |
| New client with old relay-only infrastructure | Bluetooth is just another transport; no effect on other transports |
| Client and Hub on different link minor versions | Negotiate down to the common minor; unknown control messages ignored |
| Client and Hub on incompatible link majors | Hub uses a different service UUID; client reports "update needed" |
| Hub and Hub (Android and desktop) | Same link, same sync protocol; interoperability is a tested requirement (SC-011) |
| Rolled-back Hub build | Stored packets are original bytes, so older Hub builds read the store (segment format is versioned; an unknown version is refused, not rewritten) |
