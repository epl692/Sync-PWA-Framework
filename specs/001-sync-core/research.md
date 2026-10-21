# Research: Sync Core

All items that were open in the Technical Context are resolved here. Each entry lists the decision, rationale, and alternatives.

## R-01: Second reference transport is WebRTC with manual signaling

- **Background**: The original choice, Web Bluetooth, cannot connect two browsers. The API exposes only the central (GATT client) role, and there is no way for a web page to host a service. Clarification session 2026-10-20 dropped Bluetooth from v1 and chose WebRTC with manual signaling.
- **Decision**: `transport-webrtc` opens an `RTCDataChannel` between two browsers. Pairing needs no server:
  1. Device A calls `createOffer()` and shows a **pairing code** (QR or copyable text).
  2. Device B scans or pastes it, calls `acceptOffer(code)`, and shows an **answer code**.
  3. Device A scans or pastes the answer with `acceptAnswer(code)`. The channel opens and the core sync protocol takes over.
- **Pairing code**: Non-trickle ICE (wait for gathering to finish so the code is complete). The payload is `{ver, kind: offer|answer, sdp, nonce, expiresAt}`, deflate-compressed (`CompressionStream`) and base64url-encoded. A data-channel-only SDP is a few hundred bytes compressed, well within a QR code. Codes expire (default 10 minutes) and are single-use. A malformed, expired or replayed code fails with a typed error and no state change (spec edge case).
- **Network reach**: Default is no ICE servers, so it works offline on a shared LAN. Chromium hides LAN addresses behind mDNS names, which can fail on networks that block mDNS. Apps may configure `iceServers` (STUN/TURN) to cross NATs, but v1 provides no default relay and does not claim cross-network success.
- **Identity**: A pairing code carries a DTLS fingerprint, which stops a passive observer but not someone who swaps the code in transit. Who the peer is, and whether it is trusted in a Space, is spec 002. Per Principle IV the transport is never trusted with authority.
- **Effect on Story 4**: Scenario 2 works with any device B that runs both transports (for example B holds a server connection and a WebRTC link to C). Scenario 5 (offline pairing) is covered by the manual-signaling flow. Scenario 4 maps to the transport reporting `unsupported` or `unavailable`.
- **Alternatives considered**: signaling through the relay server (smaller UX, but forces a server and was rejected in clarification); Web Bluetooth browser-to-hub (needs extra hardware and a Node peripheral); native Bluetooth via a wrapper (breaks pure static hosting). A pluggable signaling interface stays internal so a server-assisted signaler can be added later without core changes.

## R-02: Conflict model and clock

- **Decision**: Hybrid logical clock. A clock is `(wallMs: 48 bit, counter: 16 bit, deviceId)`. It is serialized as fixed-width hex `wwwwwwwwwwww-cccc-<deviceId>`, so plain string comparison equals clock order and the device ID is the deterministic tiebreaker (FR-007).
- **Drift bound (FR-008)**: A received clock updates the local HLC only up to `now + maxDrift` (default 5 min, configurable). A packet beyond the bound is still **applied with its own clock** (it must be, or devices would diverge), but it does not drag the local clock forward.
- **Skewed-device mitigation**: When a local write touches a field, its new clock is `max(localHlc.tick(), existingFieldClock.next())`. A user who has *seen* a skewed value can always overwrite it, so a device with a wildly wrong clock only wins truly concurrent edits and cannot lock a field forever. The only edits a skewed device wins are ones the other side has not seen yet.
- **Alternatives**: Lamport clocks (no wall-time hint, so LWW feels arbitrary to users); vector clocks per field (large, and the spec chose LWW); dropping or rejecting far-future packets (breaks order independence, since different peers reject at different times).

## R-03: Merge as a state-based CRDT

- **Decision**: Every non-delete packet means "for each `(field, value)`, keep it if its clock is greater than the stored field clock". Delete sets a sticky tombstone. Object `type` and `space` come from the lowest-clock packet seen (deterministic). Together these form a join-semilattice: apply is idempotent, commutative and associative (FR-006).
- **Delete vs edit (FR-012)**: The tombstone is sticky regardless of clock. Types that opt into "edit resurrects" (a flag spec 003 will define) use: `visible = !deleted || maxFieldClock > deleteClock`. The core stores `deleteClock` so this is a pure read-time rule and needs no migration.
- **Create/update ordering**: A create is just an update carrying `op: create`. If an update arrives before its create, it materializes an object stub. The create later fills any remaining fields. Nothing is buffered.
- **Alternatives**: Operation-based CRDTs with causal delivery (needs ordered delivery, which relays and unreliable links can't promise); full document CRDTs such as Yjs or Automerge (heavy runtime dependency, more power than the spec asks for, and conflicts with the one-packet-per-change model).

## R-04: Packet format and identity

- **Decision**: Envelope fields are `v, id, author, seq, space, clock, codec, body, sig`. `id = author + ":" + seq`. `author` is a random 128-bit device ID created at install. `seq` is a per-author monotonic counter persisted in the same IndexedDB transaction as the packet.
- **Sealed vs clear**: The body, produced by the payload codec, holds `{obj, op, type, schemaVersion, fields}`. With the encrypting codec of spec 002 that hides object IDs, types and values from relays. The envelope still leaks author, space, seq and clock, which is the "minimum metadata to route" the constitution allows.
- **Encoding**: Canonical JSON (sorted keys, UTF-8, bytes as base64url). It is deterministic for signing, has no dependency, and is easy to debug. Cost is ~33% on binary data. The `v` field allows a later CBOR move. Original received bytes are stored and relayed verbatim so signatures never break.
- **Alternatives**: UUID per packet (loses the free per-author gap tracking); CBOR now (needs a library or ~200 LOC for marginal gain at this stage); Protobuf (schema compiler, wrong fit).

## R-05: Resumable sync (Sync Summary)

- **Decision**: A summary is, per Space, a map `author → sorted interval list of held seqs`, for example `{ a1: [[1,500],[512,530]] }`. Peers exchange summaries, compute the diff, and send only the missing intervals, in bounded batches. Intervals stay tiny even with relayed gaps. A compacted range counts as held.
- **Alternatives**: Bloom filters or IBLT set reconciliation (probabilistic, more complex; revisit above ~1M packets); a single high-water mark per author (breaks when relay delivers out of order); timestamp cursors (clock skew makes them unsafe).

## R-06: Multi-transport, dedup and relay

- **Decision**: A `TransportManager` owns N transports. Dedup is by packet `id` against the local summary, so a duplicate is dropped before decode, and it works across transports. Relay forwards each newly accepted packet to every peer except its source, subject to per-Space settings (default on). The same dedup stops loops: when A→B→C→A returns, A already holds the id and drops it silently. Per-peer "known" sets built from summaries stop echo.
- **Alternatives**: hop counts (spoofable, unneeded with ids); TTL in the envelope (extra field to sign and trust).

## R-07: Transport contract shape

- **Decision**: A transport is `{ id, capabilities, supported(), start(), stop(), state, onPeer, onMessage, send(peerId, bytes) }`. It moves opaque bytes between peers and has optional blob hooks for spec 004. The sync protocol (hello, summary, want, packets, snapshot, ack) lives in the core, so every transport gets resumption, dedup and relay for free. The contract suite drives pairs of transports through scripted scenarios: delivery, ordering tolerance, reconnect, large payloads, unsupported-environment reporting, and abrupt close.
- **Fragmentation**: Transports with small message limits frame internally (WebRTC data channels have a practical per-message limit near 16 KiB for interop). The core ships a shared `chunk/reassemble` helper with a length-prefixed, CRC-checked frame.
- **Alternatives**: transports that implement summaries themselves (every transport re-implements sync, which is the bug source we want to avoid); a stream-oriented API (WebSocket and data channels are message-oriented already).

## R-08: Packet validators and payload codec

- **Decision**:
  - `PayloadCodec { id, encode(body, ctx) → bytes, decode(bytes, ctx) → body | Undecodable }`.
  - `PacketValidator { phase, validate(envelope, body?, ctx) → accept | reject(reason) | defer }`. Validators run in registration order on send and on apply, on one path (FR-005, FR-010).
  - `defer` parks a packet (for example "key not yet known"). Parked packets are stored, counted as held, relayed, and retried when `ctx.revalidate()` is triggered.
  - Unknown codec IDs and unknown envelope versions are treated like `defer`: store and relay, never drop (FR-009).
- **Plaintext codec**: in `testkit` only. Not exported from the release entry point.

## R-09: Storage layout and quota

- **Decision**: IndexedDB stores `objects`, `packets` (keyed `author:seq`, indexed by space and clock), `outbox`, `summary`, `snapshots`, `meta`. One transaction per applied batch. In-memory type and ID indexes are rebuilt lazily.
- **Quota**: Call `navigator.storage.persist()` at startup (best effort) and monitor `estimate()`. On `QuotaExceededError`: local writes fail loudly with a typed error (never silently drop), inbound batches pause, and a `storage:pressure` event fires. Compaction can be triggered early.
- **Alternatives**: SQLite WASM (heavy, OPFS support uneven on iOS); localStorage (too small, synchronous).

## R-10: Reactive queries

- **Decision**: Queries are `Observable`-style (`subscribe(cb)` returning unsubscribe; also `AsyncIterable`). Each applied batch computes the set of changed `(type, id)`, and queries re-evaluate only if they match those. Emissions are coalesced per microtask, which meets the 50 ms target without scheduler tricks. A re-delivered packet changes nothing, so nothing is emitted (Story 2, scenario 3).
- **Alternatives**: RxJS (runtime dependency); polling (wasteful, laggy).

## R-11: History, undo and compaction

- **Undo**: Compute the previous value of each touched field from the log, then emit a normal *update* packet with those values at a fresh clock. Undo of a create is a delete. Undo of a delete is only supported for resurrect-enabled types (R-03); otherwise it reports `NotUndoable`.
- **Snapshots**: Compaction folds every packet older than the retention window into a state-based snapshot per Space. The snapshot holds each object's fields with their clocks, tombstones, and the interval set it covers. Merge is the same join, so installing a snapshot is idempotent and order-independent. A stale peer receives the snapshot plus newer packets and converges. Tombstones are kept in snapshots indefinitely in v1 (small), and GC is deferred.
- **Size target**: With many edits per field, the snapshot keeps only the latest value per field, which gives the ≥80% reduction in SC-006.
- **Atomicity**: Compaction writes the snapshot first, then deletes packets in a second transaction, so a crash in between loses nothing.

## R-12: Testing strategy

- **Convergence**: fast-check generates a random op set, a random partition, random delivery orders including duplicates, and per-device clock skew. After full delivery, all peers' canonical state hashes must match. CI runs 10,000 runs per build (SC-004). Seeds are logged so failures replay.
- **Contract suites**: `testkit/transportContract()` and `testkit/storageContract()` take a factory, so any third party can run them (SC-005, Principle VIII).
- **Test-first**: tasks order each suite before its implementation, and the first commits must fail.

## R-13: Edge-case handling

| Edge case | Handling |
|---|---|
| Wildly wrong clock | R-02 (drift bound plus per-field causal bump) |
| Unknown type or newer format | Park, store, relay (R-08) |
| Corrupt/truncated packet | Frame CRC and envelope parse fail before apply. Reject that packet only and report on the transport's `error` stream |
| Quota exceeded | R-09 |
| Huge initial sync | Summary diff, bounded batches (default 500 packets or 1 MB), yield between batches, progress events |
| Older peer receives newer format | `hello` carries `minProtocol` and `maxProtocol`. Negotiate down for control messages. Envelope `v` is not understood → park and relay |
| Bad pairing code | Expired, malformed or reused codes fail with a typed `PairingError`. No partial connection is left open |
| No direct WebRTC route | Pairing times out (default 30 s), the transport reports `error` with `unreachable`, and other transports continue |
| Relay loop | Dedup by id, no echo to source (R-06) |
