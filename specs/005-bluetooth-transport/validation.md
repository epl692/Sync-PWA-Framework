# Validation: Bluetooth Local Transport (005)

Recorded 2026-11-27. This is an honest account of what was verified and what was not. **The native Hub apps were not built, and nothing was
run on a real Bluetooth radio.** Everything below that says "verified" ran against the deterministic radio simulator (`MemoryBleLink`).

## Automated results

| Command | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm run lint` | clean |
| `npm test` (whole repo) | all pass except one pre-existing flaky test: `packages/relay-server/tests/blob-relay.test.ts` "survives a restart" fails intermittently with `ENOTEMPTY` while cleaning a temp directory. It failed the same way before this feature's changes (checked with `git stash`) |
| `npm run test:bluetooth`, `npm run test:hub` | pass |
| Property and adversarial suites | convergence (150 and 300 runs, found and fixed a reconnect race), frame/loss/duplication properties, adversarial link tests |

## Success criteria

| SC | Evidence | Status |
|---|---|---|
| SC-001 first sync of 1,000 objects | `tests/perf/sync-volume.test.ts`: 824 KB down, 20 KB up. At 20 KB/s about 41 s, at 100 KB/s about 8 s (goal: under 5 minutes, research R-17 under 2 minutes and 30 s). Computed from bytes, not measured on a radio | simulator only |
| SC-002 edit appears within 3 s | `integration/two-clients.test.ts` (including at 20-byte frames) | simulator only |
| SC-003 resume re-sends nothing delivered | `integration/resume.test.ts` | simulator only |
| SC-004 stranger learns nothing, Hub holds no content key | `access/not-served.test.ts`, `unit/release-surface.test.ts`, `packages/spaces/tests/unit/hub-access.test.ts` | verified |
| SC-005 first use under 1 minute, at most 2 confirmations | one confirmation (`trust.test.ts`); not timed with a person | partly |
| SC-006 late client receives an absent client's changes, once each | `integration/store-forward.test.ts` (also across a Hub restart) | simulator only |
| SC-007 passes the Transport contract suite, no core change | `contract.test.ts` at MTU 23, 185, 247 (39 tests); `git diff` shows no change to `packages/core` | verified |
| SC-008 everything works without Bluetooth or a Hub | `status.test.ts`, panel tests, `trust.test.ts`; transport reports unsupported without throwing | verified |
| SC-009 8-hour soak, no lost packets | not run | **not done** |
| SC-010 install and pair a Hub in 5 minutes | no installable Hub app exists | **not done** |
| SC-011 Android and desktop Hubs interoperate | Hub-to-Hub in simulation (`hub-to-hub.test.ts`); no Android or desktop Hub exists | **not done** (simulator only) |

## Spikes (hardware)

| Spike | Status |
|---|---|
| S-1 Hub bridges on Windows, macOS, Linux | not run |
| S-2 write-size probe on real browsers and adapters | not run. The probe ladder and halving fallback are implemented and tested in the simulator at MTU 23, 185, 247 |
| S-3 concurrent connection limits | not run. Default `maxClients` is 7 until measured |
| S-4 `getDevices()` / `watchAdvertisements()` | not run. `getDevices()` reconnection is implemented and tested with a simulated browser that has it and one that does not. `watchAdvertisements()` is not used yet (reconnection retries with backoff instead) |

## Hardware matrix (`quickstart.md` section 3)

Not run (no devices). Rows 1 to 10 are open.

## What was built, and what was not

Built and tested: spaces amendment S-2 (access keys, serve and link codes), the link protocol (frames, handshake, scheduler, resync), the browser
transport and module, the client panel and confirm and code screens, the Hub (relay with admission, persistence hooks, link server,
clients, approval, automatic Spaces, limits, retention, delivery tracking, Hub-to-Hub, attached transports, blob storage), the owner
screens, the simulator, the mock bridge and bridge contract suite, the store contract suite and two stores (memory, crash-safe segment files),
the sidecar protocol client, the blob `sourceFilter` hook and the 5 MiB Bluetooth ceiling.

Not built:

- Android Hub (Capacitor shell, Kotlin plugin, foreground service) and its instrumented contract test.
- Desktop Hub (Electron shell) and the three native bridges (Windows WinRT sidecar, macOS Swift sidecar, Linux BlueZ over D-Bus).
- The Capacitor filesystem adapter for the segment store (the Node and memory adapters exist).
- Central-role methods in the native bridges (the mock bridge has them).
- Playwright end-to-end test and demo page, the `hub:dev` console harness.
- QR code display and scanning (text codes work everywhere; a QR needs a library).
- `watchAdvertisements()`-triggered reconnection.
- The client message for "you were away longer than the Hub kept changes" (the Hub drops expired data; the client is not told).
- Pending and received packet counts from sync summaries (the link reports its own send backlog and an idle/syncing state).
- Hub key storage in the platform keystore (the reference stores write the seed unencrypted).

## Known limitations found while implementing

- The relay keeps stored packets in memory as well as on disk (write-behind persistence plus preload at start). Memory use grows with
  what the Hub stores; the 1 GiB default storage limit is too high for a phone until packets are served from disk (open item).
- A packet evicted or expired from storage stays counted as held by the relay, so peers that have it do not resend it; the Hub just cannot
  serve it any more.
- Loss detection relies on sequence gaps, ACK timeouts (3 s) and reassembly timeouts; the sync layer does not re-request on its own, so a
  detected loss restarts the sync handshake with an acknowledged `resync`.
