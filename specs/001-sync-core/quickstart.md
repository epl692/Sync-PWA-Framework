# Quickstart: Validating Sync Core

Runnable scenarios that prove the feature end to end. Interfaces are in [contracts/](./contracts/), and entities in [data-model.md](./data-model.md). Commands assume the workspace layout in [plan.md](./plan.md).

## Prerequisites

- Node 20+, npm 10+
- Chromium via Playwright (`npx playwright install chromium`)
- For manual check S7 only: two devices on the same local network, each with a current browser (a laptop webcam or phone camera can scan the QR code)

```bash
npm install
npm run build
```

## S1. Offline CRUD and restart (Story 1, SC-001)

```bash
npm run test -w @sync/core -- tests/integration/offline.test.ts
npm run e2e -- offline-reload
```

**Expect**: with no transport added, create/update/delete succeed. A reload shows identical state. The outbox contains one packet per change.

## S2. Realtime between two devices (Story 2, SC-003)

```bash
npm run relay-server            # ws://localhost:8787, opaque store-and-forward, in memory only (clients resend after a restart)
npm run e2e -- two-browser-realtime
```

**Expect**: a field edited in browser A appears in B's live query within 1 s (p95 over the run). Re-delivering the same packet causes no emission.

## S3. Convergence property tests (Story 3, SC-004)

```bash
npm run test:property -w @sync/core                 # quick: 500 runs
CONVERGENCE_RUNS=10000 npm run test:property -w @sync/core   # release gate
```

**Expect**: 100% of runs produce identical state hashes across peers with random ops, orderings, duplicates, partitions and ±hours of clock skew. A failure prints the seed. Replay with `CONVERGENCE_SEED=<seed>`.

## S4. Contract suites (Story 4, SC-005)

```bash
npm run test:contract -w @sync/transport-websocket
npm run test:contract -w @sync/transport-webrtc          # mock RTCPeerConnection pair
npm run test:contract -w @sync/core -- storage          # memory + IndexedDB adapters
```

**Expect**: all green. To validate a third-party transport, call `transportContract(() => new MyTransport(...))` from `@sync/testkit` in its own test file.

## S5. Multi-transport dedup and relay (Story 4)

```bash
npm run test -w @sync/core -- tests/integration/multi-transport.test.ts
```

**Expect**: a packet delivered via two transports applies once. A (WebSocket only) → B (both) → C (WebRTC only): C receives A's write. A relay ring A→B→C→A terminates, with no repeated applies.

## S6. History, undo, compaction (Story 5, SC-006)

```bash
npm run test -w @sync/core -- tests/integration/compaction.test.ts
npm run bench -w @sync/core -- compaction     # 100k packets
```

**Expect**: state hash is identical before and after compaction. A fresh peer bootstraps from snapshot plus newer packets. Undo within the window emits a compensating packet. The bench reports ≥ 80% storage reduction.

## S7. WebRTC manual pairing (FR-017, Story 4 scenario 5)

Automated:

```bash
npm run e2e -- webrtc-pairing       # two Chromium pages, offline loopback, no relay server running
npm run test -w @sync/transport-webrtc -- pairing-errors
```

Manual, two real devices on one network with the internet off:

```bash
npm run dev -w @sync/transport-webrtc    # demo page with QR display and paste box
```

On device A click **Create pairing code**. On device B scan or paste it, then show B's answer code and scan or paste it back on A. Edit on either device.

**Expect**: the channel opens and edits sync both ways. Reloading both devices and pairing again exchanges only missing packets. An expired, edited or reused code shows a clear error and leaves no half-open connection. When pairing is blocked (no route), the transport reports `unreachable` after the timeout and WebSocket sync continues unaffected.

## S8. Edge cases

```bash
npm run test -w @sync/core -- tests/integration/edge-cases.test.ts
npm run e2e -- quota
```

Covers: skewed clock, unknown type or newer envelope version (stored and relayed), corrupt packet rejected alone, quota exceeded (typed error, no data loss), large initial sync with progress events.

## Done when

All of S1 to S6 and S8 pass in CI, S3 runs at 10,000 runs on release builds, and S7 has been checked once by hand on two devices.
