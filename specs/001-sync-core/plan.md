# Implementation Plan: Sync Core

**Branch**: `001-sync-core` | **Date**: 2026-10-20 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-sync-core/spec.md`

## Summary

Build the foundation of the framework: a local-first Syncable Object store, an immutable Data Packet pipeline, a convergent per-field last-writer-wins merge on a hybrid logical clock (HLC), a single message-oriented Transport contract with a reusable contract test suite, two reference transports (WebSocket plus a reference relay server, and Web Bluetooth), and packet-log history with snapshot compaction.

Technical approach (details in [research.md](./research.md)):

- **Zero-dependency TypeScript core** over IndexedDB, behind a `StorageAdapter` contract so tests and Node processes can swap in an in-memory store.
- **State-based merge**. Every packet reduces to "merge these fields at this clock" or "tombstone". The merge is commutative, associative and idempotent. Convergence, dedup, snapshots and out-of-order delivery all follow from that one property.
- **Packet = clear envelope + opaque body.** The envelope carries only what peers and relays need to route, dedup, order and sync. The body (object ID, op, type, fields) goes through the pluggable payload codec, which is where spec 002 adds encryption. Nothing in the core needs to read a body it cannot decode.
- **Transports move opaque protocol messages.** The sync protocol (hello, summary, want, packets, snapshot) lives in the core, so a transport is only "connect, send bytes to a peer, receive bytes from a peer". That makes the contract small and the contract suite easy to write.
- **Per-author sequence numbers** give a compact, gap-tolerant Sync Summary (interval sets per author device) for resumable sync.

**Clarification applied:** Web Bluetooth cannot connect two browsers (browsers are Bluetooth clients only), so the second reference transport is **browser-to-browser WebRTC with manual signaling** (QR code or pasted code, no server). Bluetooth is a possible later transport behind the same contract. See research R-01.

## Technical Context

**Language/Version**: TypeScript 5.x, strict mode, ES2022 target; Node 20 LTS for tooling and the relay server.

**Primary Dependencies**:
- `packages/core`: **none at runtime**.
- `packages/relay-server`: `ws` (WebSocket server).
- `packages/transport-webrtc`: none at runtime (browser `RTCPeerConnection`). Dev-only: Playwright for loopback tests.
- Dev/test: `vitest`, `fast-check`, `fake-indexeddb`, `@playwright/test`, `esbuild`, `typescript`.

**Storage**: IndexedDB (via an internal thin promise wrapper, no `idb` dependency) behind `StorageAdapter`. In-memory adapter for tests and Node.

**Testing**: Vitest (unit, contract, integration). fast-check for convergence property tests (SC-004). Playwright (Chromium) for quota and real-IndexedDB checks. WebRTC is tested with a mock `RTCPeerConnection` pair for unit and contract runs, and with two real Chromium pages in Playwright (loopback, manual-signaling flow). A manual two-device LAN check is in the quickstart.

**Target Platform**: Evergreen browsers (Chrome, Edge, Safari including iOS, Firefox) for core, WebSocket and WebRTC. Node 20 for the relay server.

**Project Type**: Library monorepo (npm workspaces): core, two transports (WebSocket, WebRTC), relay server, test kit.

**Performance Goals**: Local write to live-query emit < 50 ms (SC-002). Remote edit visible < 1 s p95 (SC-003). Compaction of 100k packets shrinks storage ≥ 80% (SC-006). Randomized convergence ≥ 10,000 runs (SC-004).

**Reference test profile** (used by T029, T047, T096): 4x CPU slowdown for "mid-range phone", and 50 ms network round trip with 1% packet loss for "normal network".

**Constraints**: Offline-capable by default. No runtime dependencies in core. Core makes no assumption about transport or cipher. Main thread must never block on sync (work is batched and yields).

**Scale/Scope**: Target up to ~100k live objects and ~1M retained packets per device in v1. The object cache is write-through, with per-type indexes in memory and the rest lazy from IndexedDB. Larger scale is a later optimization.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | How the plan satisfies it |
|---|---|---|
| I. Offline-first | PASS | All reads and writes hit the local store. Sync is a background engine behind an outbox. No code path awaits a transport. |
| II. Everything is a Syncable Object | PASS | Single `objects` store. No side data store. `Outbox` and `Summary` are sync bookkeeping, not app data. |
| III. Packets are the only state change | PASS | `applyPacket()` is the single mutation path for local and remote. Merge is idempotent and commutative, verified by property tests. |
| IV. Transport agnostic | PASS | Core imports no transport. Transports implement one message-oriented contract. Multiple run at once with dedup by ID and loop-free relay. |
| V. Zero-trust, E2E | PASS (deferred by design) | Envelope has `sig` slot and the codec/validator extension points are on both send and apply paths. The plaintext codec lives in `@core/testkit` only and is not exported from the release entry point. Release is gated on spec 002. |
| VI. Modular | PASS | Core has no views. Transports, codec, validators and storage are registered plugins. |
| VII. Static-hostable | PASS | Core and WebSocket/WebRTC client transports are static bundles. The relay server is an optional transport *target*, never required. |
| VIII. Contract-tested, test-first | PASS | Contract suites for Transport and Storage. Property-based convergence tests. Tasks order tests before implementation. |

**Technical constraints**: strict TS, IndexedDB, Web Crypto reserved for spec 002, zero runtime deps in core (justified: none needed). Dependencies added elsewhere: `ws` (relay server only), none for WebRTC (browser API).

**Compatibility note (required by Development Workflow):** the packet envelope and sync protocol are versioned from day one (`v: 1`). Rules for older and newer peers are in [contracts/packet-envelope.md](./contracts/packet-envelope.md#compatibility).

**Post-design re-check (after Phase 1):** PASS. No violations. The Bluetooth limitation (R-01) was resolved by clarification. Principle IV is shown by two unlike transports (server-assisted WebSocket and serverless WebRTC) behind one contract.

## Project Structure

### Documentation (this feature)

```text
specs/001-sync-core/
├── plan.md              # This file
├── research.md          # Phase 0: decisions, rationale, alternatives
├── data-model.md        # Phase 1: entities, merge rules, state transitions
├── quickstart.md        # Phase 1: validation scenarios
├── contracts/
│   ├── packet-envelope.md   # wire format + compatibility rules
│   ├── sync-protocol.md     # messages exchanged over any transport
│   ├── transport.ts         # Transport contract
│   ├── extension-points.ts  # PayloadCodec, PacketValidator
│   ├── storage.ts           # StorageAdapter contract
│   └── public-api.ts        # app-facing API (store, queries, history)
└── tasks.md             # Phase 2 (/speckit-tasks, not created here)
```

### Source Code (repository root)

```text
package.json                 # npm workspaces
tsconfig.base.json
packages/
├── core/
│   ├── src/
│   │   ├── clock/           # HLC, drift bound
│   │   ├── packet/          # envelope, canonical encoding, ids
│   │   ├── store/           # object store, apply/merge, tombstones, outbox
│   │   ├── query/           # reactive queries, type/filter indexes
│   │   ├── sync/            # summaries, protocol engine, dedup, relay, multi-transport manager
│   │   ├── history/         # packet log, undo, snapshots, compaction
│   │   ├── storage/         # StorageAdapter, IndexedDB + memory impls, quota
│   │   ├── extension/       # codec + validator registries
│   │   └── index.ts
│   └── tests/{unit,property,contract,integration}/
├── testkit/                 # contract suites (Transport, Storage), plaintext test codec, fake clocks/networks
├── transport-websocket/     # browser client transport
├── transport-webrtc/        # data-channel transport + manual signaling (pairing codes)
└── relay-server/            # RelayHub (opaque store-and-forward) + ws server
tests/e2e/                   # Playwright: two-browser sync, offline reload, quota
```

**Structure Decision**: npm-workspace library monorepo. Core stays dependency-free and transport-free; each transport and server is its own package so apps include only what they use (Principles IV, VII). `testkit` is a separate package so the plaintext test codec can never be bundled into a release by accident (Principle V).

## Complexity Tracking

No constitution violations. Noted for transparency:

| Item | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| Five packages instead of one | Keeps core dependency-free; isolates the test-only plaintext codec; lets apps pick transports | A single package would pull `ws`, WebRTC code and the plaintext codec into every bundle |
| Custom IndexedDB wrapper | Avoids a runtime dependency in core (Technical Constraints) | `idb` is small, but "minimum dependencies" favors ~150 lines of owned code |
