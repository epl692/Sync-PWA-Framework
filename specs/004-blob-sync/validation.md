# Validation: Blob Sync (004)

Run on Windows 11, Node 24, Chromium 1248 (Playwright), 2026-10-27. Commands: `npm run typecheck`, `npm run lint`,
`npm run build`, `npx vitest run`, `npx playwright test`; the 100 MB figures with `BLOB_PERF_MB=100` and `BLOB_E2E_MB=100`.

## Result

| Gate | Result |
|---|---|
| Typecheck, lint, build (browser bundles for every package, including `@sync/blobs`) | clean |
| Unit, contract, integration, property, adversarial (`npx vitest run`) | **1188 of 1192 pass**; the 4 failures are in `packages/app-build/tests/banned-imports.test.ts` and are **pre-existing** (identical with this feature stashed): the build tool compares a Windows path (`\`) with a `/` string |
| Browser end-to-end (`npx playwright test`) | **15 of 16 pass** (including the three blob tests); the 1 failure is `crashing-module.spec.ts`, **pre-existing and unrelated**: its generated config module loses the backslashes of a Windows path (`B:Sync-PWA-Frameworkpackages…`) |
| Gate S0 (the amendments touch no existing behaviour) | every 001, 002 and 003 test unchanged and passing, apart from the pre-existing failures above |
| Contract suites | `laneContract` runs inside `transportContract` for the memory, WebSocket and WebRTC (mock) transports; `blobStorageContract` for memory, IndexedDB (fake-indexeddb) and the relay's file store |

## Quickstart scenarios

| | Scenario | Evidence |
|---|---|---|
| S1 | Attach never slows sync | `offer.test.ts` (reference packet under 1 KiB, offers sent, nothing downloaded unasked); `packet-latency.perf.test.ts`; browser `blobs.spec.ts` (100 MB: 97 packets during the transfer, p95 **6 ms idle vs 10 ms during**, ×1.7) |
| S2 | Offline attach, later upload | `offer.test.ts` (offer after reconnect), `blobs.spec.ts` offline test (object arrives at once as `missing / not-requested`, photo only on request), `blob-relay.test.ts`. Only-copy-offline variant: `fetch.test.ts` (`missing / no-source`, then completes by itself) |
| S3 | Fetch, verify, decrypt | `fetch.test.ts`, `tamper.test.ts`, `tamper.property.test.ts` (**1000 generated bit flips** anywhere in a manifest or chunk message: result always the correct blob or `failed / verification`, no wrong chunk ever stored), `verify.test.ts`, `sources.test.ts` (reordering, loss, delay), `open.test.ts`. A full blob fetch over the WebRTC mock transport and over a 20 KiB-message transport was **not** run; large and above-limit lane messages over the WebRTC mock are covered by `laneContract` |
| S4 | Resume | `resume.test.ts`: drop at ~37 %, restart from storage, **zero** `chunk` messages and zero requested ranges for indexes already stored; property over any chunk boundary (25 runs) |
| S5 | Relay holds ciphertext only | `relay-plaintext.test.ts`: marker absent from every byte through the relay and every file it wrote; second device decrypts from the relay with the first gone; `release-surface.test.ts` (no `@sync/spaces` import in the relay) |
| S6 | Dedup | `dedup.test.ts`, `attach.test.ts`: one stored copy, one transfer; other Space and post-rotation attach give different IDs |
| S7 | GC | `gc.test.ts`: 30-day retention from the last reference, undo before then keeps the blob, 24 h for never-referenced attaches, a second reference keeps it |
| S8 | Budget, LRU, pins | `eviction.test.ts`, `policy.test.ts`, `refetch.test.ts` (re-fetch omits the manifest flag; evict and re-request 30 runs; pressure trigger only with a budget) |
| S9 | Keys: rotation, share isolation | `keys.test.ts` with real secure devices: members with all epochs open old and new blobs; a removed member keeps what it downloaded and gets `failed / no-key` for the new epoch; a Space member outside a share fetches ciphertext only and `open` fails with `no-key`; a pre-share attachment stays readable (documented parity) |
| S10 | Quota mid-download | `quota.test.ts`, `refetch.test.ts`: `failed / quota`, verified chunks kept, resumes when room appears; `evictOnQuota` frees an evictable blob and completes |
| S11 | Mixed versions | `mixed-versions.test.ts`: packets converge across an old device that never receives a lane byte; a peer speaking another blob version is neither offered nor served |
| S12 | Static host app | `blobs.spec.ts` drives two real browsers through the relay; the sample app (todo photo field, `<sync-blob>`) builds and passes `pwa-static`, `static-hosting`, `runtime-modules` and `offline-reload`. **Gap:** no end-to-end test attaches a photo through the sample app's own file input |

Module authoring check: the sample todo type gained a `photo` blob field and a file input/`<sync-blob>` in a few lines
following `docs/blobs.md` (`packages/sample-app/modules/todo/index.ts`); the "under 15 minutes" claim was not timed.

## Success criteria

| | Criterion | Result |
|---|---|---|
| SC-001 | An object with a 100 MB attachment appears as fast as one without | Browser, 100 MB: p95 packet latency 6 ms idle, 10 ms during the transfer (limit: 2× and +250 ms). In-process Node, 100 MB: 1.4 ms idle, 0.9 ms during |
| SC-002 | 100 % of tampered chunks rejected | 1000 generated cases, none stored or yielded; plus targeted tests |
| SC-003 | Relay-stored blobs contain no plaintext | `relay-plaintext.test.ts` |
| SC-004 | An interrupted 100 MB transfer resumes without re-sending completed chunks | `resume.test.ts` (30-chunk and generated cases) |

## Budgets (research R-13), measured

| Budget | Target | Measured |
|---|---|---|
| Attach throughput, desktop | ≥ 20 MB/s | 99 MB/s (Node, 100 MB); 122 MB/s (32 MB) |
| Attach throughput, phone profile (4× CPU slowdown, Chromium) | ≥ 5 MB/s | **13.0 MB/s** (32 MB) |
| Memory above baseline during a 100 MB fetch | ≤ 16 MiB | **8.4 MiB** (disk to a store that keeps nothing). The 100 MB attach into memory storage cannot separate working memory from the stored ciphertext; the 32 MB attach showed no growth beyond the stored data |
| Fetch throughput (disk store to discarding store, in one process) | none stated | 30 MB/s |
| Reference index cost | < 1 ms per applied packet | **0.14 ms** |
| GC / eviction slice (longest event-loop pause) | < 16 ms | **16.6 ms**: marginally over the target (1500 blobs in slices of 50, memory storage); the test asserts under 100 ms. Slices could be smaller if this matters |

## Constitution gate review (post-implementation)

| Principle | Verdict | Evidence |
|---|---|---|
| I Offline-first | PASS | Attach encrypts and stores locally with no transport (`attach.test.ts`, browser offline test); opening a local blob needs no network; missing blobs show a placeholder |
| II Everything is a Syncable Object | PASS (justified in plan) | Only the reference is synced state, an ordinary field; bytes are immutable and referenced only from fields |
| III Packets are the only way state changes | PASS | Attach/replace/remove change a field by packet; the reference index, pins, replicas and eviction are device-local derived state; property tests cover reorder, duplication, loss and resume |
| IV Transport agnostic | PASS | The lane rides `Transport.send`; `laneContract` is part of `transportContract`; nothing in `@sync/blobs` names a transport |
| V Zero-trust, E2E | PASS | Per-scope derived keys; relay has no keys (guard test + plaintext scan); every chunk verified; 1000-case tamper property |
| VI Modular | PASS | New package; the core gained only the generic lane, peer info and `onApplied.object`; modules use `ctx.blobs` behind the access guard (`blobs-facade.test.ts`) and cannot import `@sync/blobs` (build and lint refuse) |
| VII Static-hostable | PASS | No backend needed; the relay is an optional transport target; the sample app with blobs builds and passes the static-host e2e tests |
| VIII Contract-tested, test-first | PASS | `laneContract`, `blobStorageContract`, known-answer vectors from an independent script, property and adversarial suites |

Compatibility note (Development Workflow): the packet envelope, signing and the 002 codec are unchanged; the additive
wire changes are `hello.lanes` and the `0xB1` lane (older peers are never sent lane bytes: `mixed-versions.test.ts`).

## Defects found by the tests while building (and fixed)

A peer's blob hello could overtake the sync hello that names its lanes (inbound lane messages now wait for earlier
messages, without joining the queue); lane peers present before a lane was registered never reported a disconnect, so a
reconnect left the other side silent (regression test added to the core suite); a chunk that arrived before the manifest
or while being stored could be requested twice; a manifest rejected three times never failed the transfer; a lost
manifest message was never re-asked; a finished transfer did not free window slots for parked ones; a `get` range with a
huge upper bound looped over it; `EPERM` renaming over an open file on Windows in the relay's file store; non-canonical
spellings of one blob ID; a never-referenced blob wrongly got the 30-day retention clock instead of the 24-hour orphan rule.

## Differences from the plan, and known gaps

- **Enabling blobs**: an app passes a factory (`AppConfig.blobs`, or `StartOptions.blobs`), not a flag, so `@sync/modules` never imports `@sync/blobs` at runtime. `@sync/modules` imports only `@sync/blobs/ref`, so `@sync/blobs` must be installed for any build that includes `@sync/modules` (a bundler cannot skip the import).
- **Chunk requests ride with the manifest request** (verified before storing) instead of waiting a round trip for the manifest.
- **Additions to the contracts** made during implementation: `StoredBlob.complete`, `BlobStorage.moveChunks`, `BlobsConfig.requestTimeoutMs`, `BlobRelayOptions.onError`; blob IDs must be in canonical base64url.
- **A deleted object holds no references**, so the retention clock starts at the delete (30 days, the history window) rather than at compaction.
- **T007** uses short real timers instead of a fake clock (the point is that a slow lane write does not delay a packet).
- **Not done**: a full-blob fetch over the WebRTC mock or a 20 KiB-message transport; a sample-app end-to-end test of the photo UI; OPFS storage; timing the 15-minute authoring claim; rate limiting on a relay beyond per-peer pending ranges (see `security-review.md`).
