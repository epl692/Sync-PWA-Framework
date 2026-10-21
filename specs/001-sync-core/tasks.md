---

description: "Task list for Sync Core (001-sync-core)"
---

# Tasks: Sync Core

**Input**: Design documents from `/specs/001-sync-core/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Tests**: INCLUDED and written first. Constitution Principle VIII requires test-first work, contract suites for every plugin contract, and property-based convergence tests. Within each story, run the test tasks and confirm they FAIL before starting the implementation tasks.

**Organization**: Tasks are grouped by user story so each can be built and tested on its own.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an unfinished task)
- **[Story]**: US1 to US5, matching the priorities in spec.md
- Paths follow the monorepo layout in plan.md (`packages/<name>/...`, `tests/e2e/`)

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Workspace, tooling, and guardrails

- [ ] T001 Create root `package.json` (npm workspaces `packages/*`, Node >=20) and `tsconfig.base.json` with `strict: true`, target ES2022, in `B:\Sync-PWA-Framework`
- [ ] T002 [P] Scaffold the five packages with `package.json` and `tsconfig.json`: `packages/core` (`@sync/core`), `packages/testkit` (`@sync/testkit`), `packages/transport-websocket`, `packages/transport-webrtc`, `packages/relay-server`. `@sync/core` MUST declare no runtime `dependencies`; `@sync/testkit` imports only types from `@sync/core`
- [ ] T003 [P] Configure ESLint and Prettier in `eslint.config.js` and `.prettierrc`
- [ ] T004 [P] Configure Vitest workspace in `vitest.workspace.ts`; add dev deps `vitest`, `fast-check`, `fake-indexeddb`
- [ ] T005 [P] Configure Playwright (Chromium) in `playwright.config.ts` with `tests/e2e/` as test dir
- [ ] T006 [P] Add esbuild build scripts and the root npm scripts used by quickstart.md (`build`, `test`, `test:property`, `test:contract`, `e2e`, `bench`, `relay-server`, `dev`) in root `package.json`
- [ ] T007 [P] Add CI workflow in `.github/workflows/ci.yml` (build, unit, contract, e2e; `CONVERGENCE_RUNS=10000` on release builds)
- [ ] T008 [P] Add a release guard test in `packages/core/tests/unit/release-surface.test.ts` that fails if `@sync/core`'s exports or dist import `@sync/testkit` or the plaintext codec (Principle V), and that `@sync/core` has zero runtime dependencies

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Wire format, clock, storage, and extension registries that every story needs

**CRITICAL**: No user story work starts until this phase is complete

### Tests first

- [ ] T009 [P] Unit tests for canonical JSON (sorted keys, base64url bytes, rejects `NaN`/`Infinity`, stable bytes) in `packages/core/tests/unit/canonical.test.ts`
- [ ] T010 [P] Unit tests for HLC: tick monotonic, string order equals clock order, device ID tiebreak, fixed-width format `wwwwwwwwwwww-cccc-<deviceId>` in `packages/core/tests/unit/hlc.test.ts`
- [ ] T011 [P] Unit tests for envelope invariants: `id === author + ":" + seq`, clock suffix equals author, unknown extra fields preserved, original bytes kept in `packages/core/tests/unit/envelope.test.ts`
- [ ] T011a [P] Unit tests for inbound limits (FR-021): oversized envelope, more than 256 fields, delete body with fields, and `seq` jump above `limits.seqGapWarn` accepted with a warning event, each rejecting only that packet, in `packages/core/tests/unit/limits.test.ts`
- [ ] T012 [P] Unit tests for interval sets (add, merge adjacent, diff, contains, compaction-covered ranges) in `packages/core/tests/unit/intervals.test.ts`
- [ ] T013 [P] Storage contract suite `storageContract(factory)` (atomic multi-store transaction, rollback on throw, scan by index and range, `StorageQuotaError` leaves state unchanged) in `packages/testkit/src/storageContract.ts`, with a runner for the memory adapter in `packages/core/tests/contract/storage-memory.test.ts` and for IndexedDB (fake-indexeddb) in `packages/core/tests/contract/storage-indexeddb.test.ts`

### Implementation

- [ ] T014 [P] Implement canonical JSON encode/decode in `packages/core/src/packet/canonical.ts`
- [ ] T015 [P] Implement the HLC in `packages/core/src/clock/hlc.ts`, including the drift bound: a remote clock updates the local HLC only up to `now + maxDriftMs` and the packet is still applied with its own clock (FR-008)
- [ ] T016 [P] Implement ID generation (128-bit random base32 device IDs and object IDs) in `packages/core/src/packet/ids.ts`
- [ ] T017 Implement envelope type, build, parse and validate per [contracts/packet-envelope.md](./contracts/packet-envelope.md) in `packages/core/src/packet/envelope.ts` (depends on T014, T016)
- [ ] T017a Enforce `limits` from [data-model.md](./data-model.md) (envelope size 256 KiB, 256 fields per packet, `delete` bodies carry no fields) by rejecting that packet only, in `packages/core/src/packet/envelope.ts` and `packages/core/src/store/apply.ts` (depends on T017, T011a)
- [ ] T018 [P] Implement interval-set utilities in `packages/core/src/sync/intervals.ts`
- [ ] T019 [P] Add `StorageAdapter`, `StorageTx`, `StoreName` and `StorageQuotaError` from [contracts/storage.ts](./contracts/storage.ts) in `packages/core/src/storage/types.ts`
- [ ] T020 [P] Implement the in-memory adapter in `packages/core/src/storage/memory.ts`
- [ ] T021 Implement the IndexedDB adapter (own thin promise wrapper, stores `objects`, `packets`, `outbox`, `summary`, `snapshots`, `meta`; indexes `bySpace`, `byClock`, `byAuthor`; maps `QuotaExceededError` to `StorageQuotaError`) in `packages/core/src/storage/indexeddb.ts` (depends on T019)
- [ ] T022 [P] Implement codec and validator registries per [contracts/extension-points.ts](./contracts/extension-points.ts) (`registerCodec`, `registerValidator`, ordered run on send and apply) in `packages/core/src/extension/registry.ts`
- [ ] T023 [P] Implement the plaintext test codec (id `test-plaintext/1`) in `packages/testkit/src/plaintextCodec.ts`. Test package only, never imported by core
- [ ] T024 [P] Implement test helpers (fake clock, seeded RNG, test device factory) in `packages/testkit/src/helpers.ts`
- [ ] T025 Define public types, `Config` defaults (`retentionWindowMs` 30 days, `maxDriftMs` 300000, `relay` true, `batch` 500 packets / 1 MB, `confirmThreshold` 1) and the event emitter per [contracts/public-api.ts](./contracts/public-api.ts) in `packages/core/src/types.ts` and `packages/core/src/events.ts`

**Checkpoint**: Foundation ready. Stories can start.

---

## Phase 3: User Story 1 - Work Fully Offline (Priority: P1) MVP

**Goal**: Create, edit and delete objects with no transport; state survives restart; each change is a packet in the outbox.

**Independent Test**: Add no transport, run CRUD, reopen the core on the same storage, and check state and outbox ([quickstart S1](./quickstart.md)).

### Tests for User Story 1

- [ ] T026 [P] [US1] Integration test for offline CRUD and restart (scenarios 1 to 3; reopen on same storage; outbox holds one packet per change) in `packages/core/tests/integration/offline.test.ts`
- [ ] T027 [P] [US1] Unit tests for `applyPacket`: idempotent re-apply, per-field LWW with device-ID tiebreak, create-after-update stub, `{"$unset":true}` removes a field, delete sets sticky tombstone and `deleteClock`, a local write over a field whose stored clock is ahead of the local HLC gets a clock greater than it (causal bump) in `packages/core/tests/unit/apply.test.ts`
- [ ] T028 [P] [US1] Unit tests for reactive queries (by ID, by type, by `where`; initial emit; emits on change; no emit when a duplicate packet changes nothing; microtask coalescing; async iterator) in `packages/core/tests/unit/query.test.ts`
- [ ] T029 [P] [US1] Latency test: local write to live-query emit under 50 ms (SC-002) on the 4x CPU-throttled reference profile in plan.md, in `packages/core/tests/unit/query-latency.test.ts`
- [ ] T030 [P] [US1] Unit test that `seq` and the packet are persisted in one transaction (simulated crash leaves no seq gap or orphan) in `packages/core/tests/unit/seq-atomic.test.ts`
- [ ] T031 [P] [US1] Unit test for quota handling: `StorageQuotaError` surfaces as a typed local write error with no data loss, and `storage:pressure` fires, in `packages/core/tests/unit/quota.test.ts`
- [ ] T032 [P] [US1] E2E test: offline create, edit, delete, reload in Chromium with real IndexedDB in `tests/e2e/offline-reload.spec.ts`
- [ ] T032a [P] [US1] Unit test for FR-020: with no codec registered, `create`, `update` and `remove` reject with `NoCodecError` and store nothing, in `packages/core/tests/unit/no-codec.test.ts`

### Implementation for User Story 1

- [ ] T033 [US1] Implement object persistence and the visibility rule `visible = !deleted || (type.resurrects && maxFieldClock > deleteClock)` in `packages/core/src/store/objects.ts`
- [ ] T034 [US1] Implement `applyPacket` exactly as the pseudo-code in [data-model.md](./data-model.md): dedup by held id before decode, validators, codec decode, merge, record held/summary and store packet and object in one transaction, in `packages/core/src/store/apply.ts` (depends on T033, T017, T018, T022)
- [ ] T035 [US1] Implement the outbox (`OutboxEntry` `{ packetId, space, createdAt, confirmedBy }`) in `packages/core/src/store/outbox.ts`
- [ ] T036 [US1] Implement the local write path (tick HLC, per-field clock `max(hlc, next(existingFieldClock))`, `seq` from `meta`, encode, send-phase validators, `applyPacket`, outbox add; throw `NoCodecError` if no codec is registered, FR-020) in `packages/core/src/store/write.ts` (depends on T034, T035, T015)
- [ ] T037 [US1] Implement reactive queries and the changed-`(type,id)` index with microtask-coalesced emission and async-iterator support in `packages/core/src/query/engine.ts`
- [ ] T038 [US1] Implement canonical `stateHash(space)` (hash of canonical objects sorted by id, including tombstones) in `packages/core/src/store/hash.ts`
- [ ] T039 [US1] Implement quota monitoring (`persist()`, periodic `estimate()`, `storage:pressure` event, typed write errors) in `packages/core/src/storage/quota.ts`
- [ ] T040 [US1] Implement `createSyncCore` wiring (`create`, `update`, `remove`, `get`, `query`, `stateHash`, `on`, `close`, device ID bootstrap) and the package entry point in `packages/core/src/core.ts` and `packages/core/src/index.ts` (depends on T036, T037, T038, T039)

**Checkpoint**: US1 works with no transport and is a shippable MVP of the local store.

---

## Phase 4: User Story 2 - Realtime Updates From Data Packets (Priority: P1)

**Goal**: Two online devices see each other's edits live. First transport, the sync protocol engine, and the reference relay server.

**Independent Test**: Two cores on the WebSocket transport through the relay server; an edit on A updates a live query on B ([quickstart S2](./quickstart.md)).

### Tests for User Story 2

- [ ] T041 [P] [US2] Transport contract suite `transportContract(factory)` (delivery, tolerates reordering and duplicates, reconnect, message at `maxMessageBytes`, `unsupported` reporting, abrupt close, corrupt message isolated from others) in `packages/testkit/src/transportContract.ts`
- [ ] T042 [P] [US2] Unit tests for the sync protocol per [contracts/sync-protocol.md](./contracts/sync-protocol.md): `hello` version negotiation and fatal error on no overlap, summary diff, `want`, unknown `t` ignored, Spaces not in both `hello.spaces` ignored, resume after drop sends only missing packets, in `packages/core/tests/unit/protocol.test.ts`
- [ ] T043 [P] [US2] Integration test for realtime sync over the in-memory transport pair (scenarios 1 to 3; duplicate delivery emits nothing) in `packages/core/tests/integration/realtime.test.ts`
- [ ] T044 [P] [US2] Integration test for large initial sync (batches of 500 packets or 1 MB, progress events, UI yields) and for a corrupt or truncated packet rejected alone, in `packages/core/tests/integration/initial-sync.test.ts`
- [ ] T045 [P] [US2] Run `transportContract` against the WebSocket transport in `packages/transport-websocket/tests/contract.test.ts`
- [ ] T046 [P] [US2] Unit tests for `RelayHub` (stores and forwards without decoding bodies, answers summaries, never needs a key) in `packages/relay-server/tests/relayHub.test.ts`
- [ ] T047 [P] [US2] E2E two-browser realtime test through the relay server, asserting remote edit visible within 1 s at p95 (SC-003) on the reference network profile in plan.md, in `tests/e2e/two-browser-realtime.spec.ts`

### Implementation for User Story 2

- [ ] T048 [P] [US2] Implement the Transport types from [contracts/transport.ts](./contracts/transport.ts) in `packages/core/src/sync/transport.ts`
- [ ] T049 [P] [US2] Implement an in-memory transport pair for tests in `packages/testkit/src/memoryTransport.ts`
- [ ] T050 [US2] Implement protocol message types and canonical encode/decode (`hello`, `summary`, `want`, `packets`, `snapshot`, `ack`, `error`, `ping`/`pong`) in `packages/core/src/sync/messages.ts`
- [ ] T051 [US2] Implement summary build and diff in `packages/core/src/sync/summary.ts` (depends on T018)
- [ ] T052 [US2] Implement the per-peer session state machine (`hello`, summary exchange, want and packets in bounded batches with yields, live streaming, no echo to the source, skip packets the peer's summary already holds) in `packages/core/src/sync/session.ts` (depends on T050, T051, T034)
- [ ] T052a [US2] Enforce `limits.maxMessageBytes` (4 MiB) in the session: drop and report the oversized message, keep the connection, in `packages/core/src/sync/session.ts` (depends on T052)
- [ ] T053 [US2] Implement `TransportManager` (add/remove transport, peer lifecycle, `ack` clears outbox at `confirmThreshold`, `sync:progress` and `transport:state` events) in `packages/core/src/sync/manager.ts` (depends on T052, T035)
- [ ] T054 [US2] Expose `addTransport`, `removeTransport`, `transports` on the core in `packages/core/src/core.ts` (depends on T053)
- [ ] T055 [P] [US2] Implement `RelayHub` (opaque store-and-forward keyed by Space, serves summaries and missing packets; held in memory only, a restart loses nothing because clients resume by summary) in `packages/relay-server/src/relayHub.ts`
- [ ] T056 [P] [US2] Implement the `ws` server wrapper and the `npm run relay-server` entry (port 8787) in `packages/relay-server/src/server.ts`
- [ ] T057 [US2] Implement the WebSocket client transport (reconnect with backoff, `supported()` check, state events) in `packages/transport-websocket/src/index.ts`

**Checkpoint**: US1 and US2 both work. Remote edits appear live.

---

## Phase 5: User Story 3 - Converge After Being Offline (Priority: P1)

**Goal**: Any set of packets in any order, with duplicates and skewed clocks, produces identical state everywhere.

**Independent Test**: Partition, edit randomly on both sides, reconnect, compare state hashes ([quickstart S3](./quickstart.md)).

### Test infrastructure and tests for User Story 3

- [ ] T058 [US3] Implement the random scenario generator (ops over several devices, partitions, shuffled and duplicated delivery, per-device clock skew of up to hours, seed logging, `CONVERGENCE_SEED` replay) in `packages/testkit/src/scenarios.ts`
- [ ] T059 [P] [US3] Property test: at least `CONVERGENCE_RUNS` (default 500, 10,000 on release) runs end with identical `stateHash` on all peers (SC-004) in `packages/core/tests/property/convergence.test.ts`. Done when 10,000 runs pass
- [ ] T060 [P] [US3] Unit tests for the drift bound (a remote clock beyond `now + maxDrift` is applied with its own clock but never advances the local HLC past the bound) and an end-to-end skew case (a later local edit that has seen a skewed value overrides it) in `packages/core/tests/unit/clock-skew.test.ts`
- [ ] T061 [P] [US3] Unit tests for delete vs concurrent edit: object stays deleted in both orders (FR-012); a resurrect-enabled type becomes visible when `maxFieldClock > deleteClock`, in `packages/core/tests/unit/delete.test.ts`
- [ ] T062 [P] [US3] Unit tests for parked packets: unknown codec, unknown envelope `v`, unknown type, validator `defer`; each is stored, counted held, relayed, applied after `revalidate()` (FR-009) in `packages/core/tests/unit/parked.test.ts`
- [ ] T063 [US3] Integration test (runs after T052 to T053, needs the US2 session) for partition and reconnect over the real sync session (scenarios 1 to 4: different fields kept, same field LWW, any order, delete beats edit) in `packages/core/tests/integration/partition.test.ts`

### Implementation for User Story 3

- [ ] T065 [US3] Make object `type`/`space` follow the lowest-clock packet and `schemaVersion` the highest, and add the type option hook `resurrects` for the read-time rule, in `packages/core/src/store/objects.ts` and `packages/core/src/store/apply.ts`
- [ ] T066 [US3] Implement parked-packet storage (`status: "parked"` with reasons `undecodable-codec`, `unknown-version`, `validator-deferred`), relay of parked packets, `packet:parked` events, and `revalidate()` in `packages/core/src/store/parked.ts` and `packages/core/src/extension/registry.ts`

**Checkpoint**: Convergence is proven by property tests. All P1 stories are complete.

---

## Phase 6: User Story 4 - Pluggable, Simultaneous Transports (Priority: P2)

**Goal**: WebSocket and WebRTC run at once with dedup and loop-free relay; a new transport that passes the contract suite works with no core change; WebRTC pairs with no server.

**Independent Test**: Contract suite on both reference transports; both active in one app with dedup and relay ([quickstart S4, S5, S7](./quickstart.md)).

### Tests for User Story 4

- [ ] T068 [P] [US4] Integration test for multi-transport dedup, relay A (WebSocket) to B (both) to C (WebRTC), and a relay ring A to B to C to A that stops with no repeat applies, in `packages/core/tests/integration/multi-transport.test.ts`
- [ ] T069 [P] [US4] Unit tests for per-app and per-Space relay config (relay off stops forwarding for that Space only) in `packages/core/tests/unit/relay-config.test.ts`
- [ ] T070 [P] [US4] Unit tests for the framing helper (chunk, reassemble, length prefix, CRC; corrupt frame rejected without affecting later frames) in `packages/core/tests/unit/framing.test.ts`
- [ ] T071 [P] [US4] Unit tests for pairing codes: round trip, `PairingError` codes `malformed`, `expired`, `reused`, `mismatch`, `timeout`, `unreachable`; no half-open connection after failure, in `packages/transport-webrtc/tests/pairing-errors.test.ts`
- [ ] T072 [P] [US4] Run `transportContract` against the WebRTC transport using a mock `RTCPeerConnection` pair in `packages/transport-webrtc/tests/contract.test.ts`
- [ ] T073 [P] [US4] E2E test of the full manual-signaling flow between two Chromium pages with no relay server (offer code, answer code, sync, reload, re-pair resumes) in `tests/e2e/webrtc-pairing.spec.ts`
- [ ] T074 [P] [US4] Unit test that a transport whose `supported()` is false reports `unsupported`, and the app keeps syncing on the others, in `packages/core/tests/unit/transport-unsupported.test.ts`

### Implementation for User Story 4

- [ ] T075 [US4] Extend `TransportManager` for simultaneous transports: dedup by id across transports before decode, per-peer known sets from summaries, forward each new packet to all peers except its source, per-app and per-Space `relay` setting, in `packages/core/src/sync/manager.ts`
- [ ] T076 [P] [US4] Implement the shared framing helper (`chunk`/`reassemble`, length-prefixed, CRC-checked) in `packages/core/src/sync/framing.ts`
- [ ] T077 [P] [US4] Implement pairing code encode/decode (`PairingPayload` per [contracts/webrtc-pairing.ts](./contracts/webrtc-pairing.ts): `CompressionStream` deflate, base64url, `nonce`, `expiresAt` default now + 10 min, single-use tracking) in `packages/transport-webrtc/src/pairingCode.ts`
- [ ] T078 [US4] Implement the WebRTC transport (`createOffer`, `acceptOffer`, `acceptAnswer`, `cancelPairing`; non-trickle ICE; data channel; framing; optional `iceServers`; `connectTimeoutMs` default 30 s; `unreachable` error; state `needs-pairing`) in `packages/transport-webrtc/src/index.ts` (depends on T076, T077)
- [ ] T079 [P] [US4] Build the demo page with QR display, scanner and paste box (`npm run dev -w @sync/transport-webrtc`) in `packages/transport-webrtc/demo/index.html`
- [ ] T080 [US4] Add protocol version negotiation (negotiate down on `hello.protocol`; fatal error when ranges do not overlap) in `packages/core/src/sync/session.ts`
- [ ] T081 [US4] Document how to run `transportContract` for third-party transports in `packages/testkit/README.md`

**Checkpoint**: Two unlike transports run together; the contract suite gates new ones.

---

## Phase 7: User Story 5 - History, Undo, and Compaction (Priority: P3)

**Goal**: Undo through compensating packets; compaction into snapshots without changing state; stale peers bootstrap from a snapshot.

**Independent Test**: Generate long history, compact, compare hashes, bootstrap a fresh peer, undo inside the window ([quickstart S6](./quickstart.md)).

### Tests for User Story 5

- [ ] T082 [P] [US5] Unit tests for undo (restores prior field values with a new compensating packet; undo of create becomes delete; undo of delete only for resurrect-enabled types else `NotUndoable`; outside the window rejected) in `packages/core/tests/unit/undo.test.ts`
- [ ] T083 [P] [US5] Integration test: compaction leaves `stateHash` identical, tombstones retained, a fresh peer bootstraps from snapshot plus newer packets, a peer offline past the window converges (scenarios 1 to 3), in `packages/core/tests/integration/compaction.test.ts`
- [ ] T084 [P] [US5] Property test: random history, compact at a random cut, then deliver to peers; state hashes still match (SC-004 extended) in `packages/core/tests/property/compaction-convergence.test.ts`
- [ ] T085 [P] [US5] Benchmark: 100k historical packets, storage reduction at least 80% after compaction (SC-006) in `packages/core/bench/compaction.bench.ts`

### Implementation for User Story 5

- [ ] T086 [US5] Implement the packet log reader and `history(id)` in `packages/core/src/history/log.ts`
- [ ] T087 [US5] Implement `undo(id)` via compensating update packets through the normal write path in `packages/core/src/history/undo.ts` (depends on T086, T036)
- [ ] T088 [US5] Implement snapshots (`Snapshot` state per Space with `covers` interval sets, same field-wise join as packet merge, idempotent install) in `packages/core/src/history/snapshot.ts`
- [ ] T089 [US5] Implement `compact()` (write snapshot first, then delete packets in a second transaction; keep compacted ranges in `held`; never purge tombstones inside the retention window; keep tombstones in snapshots) and the retention-window trigger in `packages/core/src/history/compaction.ts` (depends on T088)
- [ ] T090 [US5] Add `snapshot` message support to the session: send a snapshot when the peer's gap is compacted away, then newer packets; chunk via `part`/`of`, in `packages/core/src/sync/session.ts` and `packages/core/src/sync/messages.ts` (depends on T088)
- [ ] T091 [US5] Expose `undo`, `history`, `compact` on the core and trigger early compaction on `storage:pressure` in `packages/core/src/core.ts`

**Checkpoint**: All five stories work.

---

## Phase 8: Polish & Cross-Cutting Concerns

- [ ] T092 [P] Edge-case integration tests (skewed clock, unknown type and newer version relayed, corrupt packet, quota exceeded, large initial sync) in `packages/core/tests/integration/edge-cases.test.ts` ([quickstart S8](./quickstart.md))
- [ ] T093 [P] E2E quota test in `tests/e2e/quota.spec.ts`
- [ ] T094 [P] Write package READMEs and a top-level `README.md` covering setup, the core API, and the dev-only plaintext codec warning
- [ ] T095 Review [contracts/packet-envelope.md](./contracts/packet-envelope.md) compatibility table against the implementation and record any mismatch as a compatibility note
- [ ] T096 Performance pass: confirm SC-002 (under 50 ms) on the reference profile in plan.md (4x CPU slowdown) and tune batching; confirm SC-003 in the E2E run
- [ ] T097 Verify static hosting: build a sample bundle of core and the WebSocket and WebRTC transports as plain static files and load it from a static server (Principle VII)
- [ ] T098 Run the full [quickstart.md](./quickstart.md) (S1 to S8) and record results; confirm S3 at 10,000 runs, and confirm spec 002 is merged before any release build (Principle V)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: none
- **Foundational (Phase 2)**: needs Phase 1. Blocks all stories
- **US1 (Phase 3)**: needs Phase 2. Delivers the MVP
- **US2 (Phase 4)**: needs US1 (applies packets, uses the outbox and the summary)
- **US3 (Phase 5)**: needs US1. T058 to T062, T065 and T066 need only the in-memory transport from T049, so they can run in parallel with US2. T063 needs the US2 session and manager (T052, T053)
- **US4 (Phase 6)**: needs US2 (session, manager, contract suite, WebSocket transport)
- **US5 (Phase 7)**: needs US1 and US3 (merge is the snapshot join). The `snapshot` message (T090) needs US2
- **Polish (Phase 8)**: needs the stories you intend to ship

### Within Each Story

- Tests are written first and must FAIL before implementation starts
- Storage and envelope before store, store before query, query before core wiring
- Protocol messages before sessions, sessions before the manager, the manager before transports

### Parallel Opportunities

- Setup tasks T002 to T008 after T001
- Foundational tests T009 to T013 together; implementations T014 to T016, T018 to T020, T022 to T024 together
- Within a story, all `[P]` test tasks run together
- US2 and US3 can run in parallel after US1 and T049 (different files except `apply.ts`, so coordinate T065 to T066 with US2 work)
- T055 and T056 (relay server) and T057 (WebSocket transport) can run in parallel

---

## Parallel Example: User Story 1

```bash
# Tests together:
Task: "Offline CRUD and restart integration test in packages/core/tests/integration/offline.test.ts"
Task: "applyPacket unit tests in packages/core/tests/unit/apply.test.ts"
Task: "Reactive query tests in packages/core/tests/unit/query.test.ts"
Task: "Local-edit latency test in packages/core/tests/unit/query-latency.test.ts"
Task: "Quota handling test in packages/core/tests/unit/quota.test.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 only)

1. Phase 1 (Setup) then Phase 2 (Foundational)
2. Phase 3 (US1)
3. **Stop and validate** with quickstart S1: CRUD offline, restart, outbox correct

### Incremental Delivery

1. Setup, Foundational, US1: working local store
2. US2: realtime over WebSocket and the relay server
3. US3: convergence proven (this completes all P1 stories and the release-blocking guarantee)
4. US4: WebRTC and simultaneous transports
5. US5: history, undo, compaction

### Notes

- No release may ship without spec 002 (Constitution Principle V). T008 keeps the plaintext codec out of the core entry point
- Any change to the envelope, the sync protocol or the Transport contract needs a compatibility note (T095)
- Commit after each task or logical group
