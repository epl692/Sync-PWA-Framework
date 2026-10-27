# Quickstart: Validating Blob Sync

Runnable scenarios that prove the feature end to end. Each maps to spec stories and success criteria. Results are recorded in `validation.md` when implemented. Wire details: [blob-protocol.md](./contracts/blob-protocol.md); formats: [blob-format.md](./contracts/blob-format.md); API: [blobs-api.ts](./contracts/blobs-api.ts).

## Prerequisites

```bash
npm ci
npm run typecheck && npm run lint
npx playwright install chromium   # only for e2e; set PW_CHROMIUM_PATH in a sandbox without it
```

## Commands

```bash
npx vitest run packages/blobs                      # unit, property, integration
npx vitest run contract                            # blobStorageContract, laneContract, existing contracts
npx vitest run packages/blobs/tests/adversarial    # tampering and hostile peers
npx vitest bench --run packages/blobs              # perf budgets (R-13)
npm run e2e -- tests/e2e/blobs.spec.ts             # two browsers, relay, offline attach
```

## Scenarios

### S1 — Attach never slows sync (US1, FR-003, SC-001)

Setup: devices A and B in one Space through the testkit relay; A attaches a 100 MB blob to a new object.
Expect: B receives the object packet and sees `observe(ref)` = `missing / not-requested` with `size` set, within the packet-sync budget of spec 001 (SC-003 there); a packet written on A during the upload reaches B with p95 latency ≤ 2× the idle baseline and ≤ 250 ms added; the packet carries only the reference (assert the encoded packet length is below 1 KiB).

### S2 — Offline attach, later upload (US1.3)

Setup: A offline attaches a file and creates the object, then connects to the relay.
Expect: the object syncs first; the relay then receives `offer` → `get`, `stored` arrives, and A's blob shows `replicas = 1`. Variant: if the only holder (A) is offline, B's `request` shows `missing / no-source` and completes automatically when A reconnects and offers (edge case: only copy on an offline device).

### S3 — Fetch, verify, decrypt (US2, SC-002)

Setup: B calls `request(ref)` with the blob on the relay only, then again with the blob on a WebRTC peer only (mock RTC), then with a Bluetooth-sized transport (`maxMessageBytes` 20 KiB, ordered, with latency).
Expect: `downloading` with rising progress, then `available`; `toBlob` equals the original bytes; every chunk of a tampered copy (flip one byte at random positions, 1000 generated cases) is rejected, discarded, and re-fetched from a second source when present, and the final bytes are correct; a tampered manifest is rejected before any chunk is requested.

### S4 — Resume (US2.2, SC-004)

Setup: B downloads 100 MB; drop the connection at 37 %, restart the engine from storage, reconnect.
Expect: only the missing chunk indexes are requested (assert on lane messages: zero chunk messages for indexes already stored); the final blob verifies.

### S5 — Relay holds ciphertext only (US2.4, SC-003)

Setup: attach a file containing a known plaintext marker; let the relay store it; scan the relay's data directory, memory dump of its storage, and all lane bytes it saw.
Expect: the marker never appears; the relay's code has no key access (no import of `@sync/spaces`).

### S6 — Dedup (US3, FR-007)

Setup: attach the same file to two objects in one Space on A, sync to B, fetch both.
Expect: one `StoredBlob` and one set of chunks on A and B, the second `attach` returns an identical reference, one transfer (count lane `chunk` messages equals chunk count). The same bytes in a different Space yield a different ID.

### S7 — GC (US3.2, FR-008)

Setup: attach, reference, then delete the object and compact; advance the fake clock past `retentionMs`; run `collect()`.
Expect: blob deleted and `blob:deleted` emitted; undo before compaction restores the reference and the blob is untouched; an attach never referenced is removed after `orphanGraceMs`.

### S8 — Budget, LRU, pinning (US4, FR-009)

Setup: budget = 3 blobs; fetch five on B; pin one; leave one unreplicated (attached locally, relay down).
Expect: eviction frees LRU unpinned replicated blobs first; the pinned and the unreplicated blob are kept even over budget; an evicted blob re-fetches on demand and its manifest round trip is skipped.

### S9 — Keys: rotation and share isolation (edge cases)

Setup: attach blob X, rotate the Space key (remove a member), attach Y. Create an override share object with blob Z.
Expect: a member holding all epochs opens X and Y; a removed member cannot fetch or decrypt Y (`failed: no-key`) but opens X if they already downloaded it; a Space member outside the share can fetch Z's ciphertext but `open` fails with `no-key` and no plaintext is produced.

### S10 — Quota mid-download (edge case)

Setup: storage adapter that throws quota after N bytes.
Expect: status `failed / quota`, verified chunks kept, `blob:failed` event, a later `request` resumes after space is freed; with `evictOnQuota: true` and an evictable blob, the fetch completes.

### S11 — Mixed versions and no-lane peers

Setup: a plain 001/002 peer and a blob-capable peer in one Space.
Expect: packets converge on all three; the blob pair transfers; the plain peer shows the reference as an ordinary field and is never sent a lane byte (assert).

### S12 — Static host app (Principle VII)

Setup: sample app built with `@sync/app-build`, served by a file-only host, relay on localhost.
Expect: attach a photo offline in one browser context, reconnect, second context sees the placeholder instantly and the photo after request; works with the relay stopped between two P2P (mock) peers.

## Module authoring check

Following `docs/blobs.md`, add a photo field (`blob` type, `accept: ['image/*']`) to the sample todo type and render it with `<sync-blob>` in under 15 minutes; a module that did not declare the Space gets `AccessDeniedError` from `ctx.blobs.attach`.
