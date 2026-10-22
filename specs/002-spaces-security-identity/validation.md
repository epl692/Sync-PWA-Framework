# Validation: Spaces, Security & Identity

Task T091. Every scenario in [quickstart.md](./quickstart.md) was run against the finished build on 2026-10-21 (Node 22, Chromium 1194 for the browser scenarios). The whole repository: 81 test files and 475 tests pass (`npx vitest run`), the 9 Playwright tests pass (`npx playwright test`), and `npm run typecheck` and `npm run lint` are clean.

| Scenario | Command (from quickstart) | Result |
|---|---|---|
| S0 core amendments, 001 unchanged | `npx vitest run packages/core` | 40 files, 207 tests pass |
| S1 encrypted Space, relay sees no plaintext (SC-002) | create-space, e2e-relay, unsupported | 12 pass |
| S2 peers enforce roles (SC-001) | `npm run test:adversarial` | 12 pass; long runs below |
| S3 invite online | `join.test.ts`; `playwright invite-online` | 9 pass; browser test passes |
| S4 invite offline (SC-004) | `playwright invite-offline-webrtc` | passes; **offline join took 4.2 s** (limit 60 s) |
| S5 link and revoke devices | link-device, revoke-device, device-limits | 9 pass |
| S6 remove a member (SC-003) | remove-member, cutoff, retroactive-rebuild | 8 pass |
| S7 private objects | override-share, share-snapshot | 8 pass |
| S8 provider swap (SC-005) | testkit suites, default-provider contract, provider-swap | 42 pass |
| S9 manual, two real devices | | **Not performed** (needs two physical devices on one network). The browser scenario S4 exercises the same path with two Chromium contexts |
| S10 edge cases | edge-cases, inert-notify, rotation, invite-race, photographed-invite | 10 pass |
| S11 performance | `tests/perf` | see below |

## Success criteria

| Criterion | Evidence |
|---|---|
| SC-001: no invalid packet applied | Named attacks (`attacks.test.ts`, 10 tests), the deterministic worst case, and randomized hostile streams over three shuffled peers against a peer that saw only the valid packets. Mutating the validator (accepting Viewer writes, ignoring the cutoff) makes the stream test fail within a few runs. Long runs: see below |
| SC-002: relay holds no plaintext | `e2e-relay.test.ts`: markers in types, field names and values never appear in anything the relay stores or forwards, including a join through it, channel messages, and a sealed snapshot |
| SC-003: removed device reads nothing new | `remove-member.test.ts`: 20 of 20 later notes unreadable on the removed device; the same for a member who leaves, a revoked device and a share |
| SC-004: QR join offline under 60 s | 4.2 s measured in two Chromium contexts, WebRTC link, pairing codes exchanged |
| SC-005: stub provider passes unchanged | The same contract suite passes for the default and stub providers and fails 7 deliberately broken ones; one Spaces scenario passes under both providers |

## Performance (research R-18; Node, one core; phone profile = 4x slower)

| Measure | Here | Phone profile | Target |
|---|---|---|---|
| Signature verification, concurrent | 10,000 to 16,000/s | 2,600 to 4,000/s | ≥ 2,000/s ✔ |
| Ingest of encrypted, signed, validated packets | 1,400 to 2,200/s | 350 to 550/s | > 300/s ✔ (plaintext test codec: about 13,000/s) |
| Key rotation for 101 devices | 195 to 270 ms | 780 to 1,100 ms | < 2 s ✔ |

The plan's "10,000-packet sync no more than 30% slower than plaintext" was dropped: it has no meaning in memory (the encrypted path costs several times the plaintext path in CPU) and a real sync is network-bound. A 10,000-packet catch-up takes about 5 s here and about 20 s on the phone profile.

## Changes to the plan found while building (all recorded in the design documents)

1. Key grants are ordinary encrypted control objects, written under the previous epoch's key; there is no `grant/1` codec (research R-09).
2. Epochs record the removals they cover (`covers`), because clock order alone can leave a removed member with a key (R-09).
3. No "history from join only" mode: the control history is encrypted under old keys, so a joiner needs every epoch (R-09).
4. Control events are never rejected for authority reasons, only made inert by the fold; otherwise two Owners removing each other never converge (R-07).
5. Snapshots: one guard; share-bound objects and control events are pinned out of compaction, so snapshots hold only Space-scoped objects; the snapshot follows the packets (R-11).
6. `verifyBinding` is asynchronous (Web Crypto) but deterministic and free of I/O; the provider's device cannot sign anything but bindings; link approval defaults to refusing (R-13, R-15).
7. The authority state and the signature cache live in memory and are rebuilt from the log; no derived data is stored (R-16).
8. Ten core additions (A-1 to A-10) instead of seven (core-amendments.md), including a concurrent signature-check hook that roughly tripled batch verification speed.
9. Offline join runs over a local-network WebRTC link in every modern browser, not Bluetooth (spec, clarified).

## Long randomized runs

`CONVERGENCE_RUNS=300` (two parallel runs): passed after the fixes in the security review. Release run (`CONVERGENCE_RUNS=10000`, seed 20261021): passed (10,000 scenarios, 3 judges each, 0 failures; 33 min on 1 file).
