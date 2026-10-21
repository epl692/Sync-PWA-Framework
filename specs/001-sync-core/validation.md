# Validation Results: Sync Core

Run on 2026-10-20 (Windows 11, Node 24, Chromium via Playwright). Scenarios are from [quickstart.md](./quickstart.md).

## Summary

| Check | Result |
|---|---|
| Typecheck (`tsc --noEmit`, strict) | clean |
| Lint (`eslint .`) | clean |
| Unit, contract, integration, property (Vitest) | 225 tests in 37 files, all passing |
| End to end (Playwright, real Chromium) | 7 tests, all passing |
| Randomized convergence, `CONVERGENCE_RUNS=10000` | 10,000 scenarios + 40,000 merge-property runs: all converge |
| Compaction convergence, 10,000 runs | all converge |
| Compaction bench, 100,000 packets | 97.7% smaller (50.8 MB to 1.2 MB), state hash unchanged |
| `@sync/core` runtime dependencies | none; the plaintext codec is absent from `packages/core/dist` |

## Scenarios

| Scenario | How it was checked | Result |
|---|---|---|
| S1 Offline CRUD and restart | `tests/integration/offline.test.ts`; `tests/e2e/offline-reload.spec.ts` (real IndexedDB) | pass |
| S2 Realtime between two devices | `realtime.test.ts` (in-memory); `two-browser-realtime.spec.ts` through the relay server | pass |
| S3 Convergence property tests | `tests/property/convergence.test.ts`, 500 runs by default, 10,000 for the release gate | pass |
| S4 Contract suites | memory transport, WebSocket, WebRTC (mock), storage (memory and IndexedDB) | pass |
| S5 Multi-transport dedup and relay | `multi-transport.test.ts` incl. a three-node relay ring that stops | pass |
| S6 History, undo, compaction | `undo.test.ts`, `compaction.test.ts`, property test, `bench/compaction.bench.ts` | pass |
| S7 WebRTC manual pairing | automated: `webrtc-pairing.spec.ts` (two Chromium pages, offer and answer codes, reload, re-pair); manual: **not done** (see below) | automated pass |
| S8 Edge cases | `edge-cases.test.ts`, `quota.spec.ts`, `initial-sync.test.ts` | pass |

## Success criteria

| ID | Target | Measured |
|---|---|---|
| SC-001 | CRUD with no transport survives restart | pass (unit and real IndexedDB) |
| SC-002 | local edit to live query < 50 ms | p95 about 7 ms in Chromium with 4x CPU slowdown, real IndexedDB, 500 objects (`latency.spec.ts`); the Node test (2,000 objects, unthrottled) also stays inside the 50 ms budget |
| SC-003 | remote edit < 1 s (p95) | 3 to 6 ms through a local relay (`two-browser-realtime.spec.ts`). The 50 ms RTT and 1% loss part of the reference profile was **not** emulated (Chromium's network emulation does not shape WebSockets); the margin is more than 100x |
| SC-004 | 100% identical hashes over >= 10,000 randomized runs | pass; a deliberately broken merge was caught by the same test |
| SC-005 | a transport that passes the contract suite needs no core change | the memory, WebSocket and WebRTC transports all pass `transportContract` unchanged |
| SC-006 | >= 80% storage reduction at 100k packets | 97.7% |

## Not verified, and why

- **Two physical devices (S7 manual).** WebRTC pairing was verified between two browser contexts on one machine, with Chromium's mDNS candidate hiding switched off for the test. A pairing between two real devices on a LAN, and the QR scan path in the demo page, have not been tried by hand. Pairing across different networks needs STUN/TURN and is not claimed.
- **Real IndexedDB quota exhaustion.** Headless Chromium does not enforce a quota on IndexedDB writes, so `quota.spec.ts` injects the `QuotaExceededError` that a real overflow raises. It proves the typed error, the rollback inside a real IndexedDB transaction and the pressure event, but not the browser's own limit.
- **Release gate (Constitution Principle V).** No release build exists. Spec 002 (encryption and signing) is not implemented, so nothing built from this repository may ship. `release-surface.test.ts` and the dist check above keep the plaintext codec out of the core.
- **Other browsers.** Only Chromium was run. Firefox and Safari are untested.
