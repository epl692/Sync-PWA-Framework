---

description: "Task list for Blob Sync (004-blob-sync)"
---

# Tasks: Blob Sync

**Input**: Design documents from `/specs/004-blob-sync/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md). Specs 001, 002 and 003 are implemented and their suites are green.

**Tests**: INCLUDED and written first. Constitution Principle VIII requires test-first work, reusable contract suites (`laneContract`, `blobStorageContract`) and property-based tests. Within each phase, run the test tasks and confirm they FAIL before starting the implementation tasks.

**Organization**: Tasks are grouped by user story. Story order follows priority (P1: US1, US2; P2: US3; P3: US4). US2 needs the attach pipeline from US1 to produce real blobs, so the practical order is US1 then US2; US3 (needs the reference index) and US4 (needs the policy module) then follow and are independent of each other. Foundational phase 2 carries everything the stories share: the amendments, the format and crypto code, storage and the lane codec.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an unfinished task)
- **[Story]**: US1 to US4, matching the stories in spec.md
- Paths follow plan.md. Folders `format`, `crypto`, `storage`, `attach`, `protocol`, `transfer`, `serve`, `refs`, `policy`, `status`, `ui` are under `packages/blobs/src/`. Tests are under `packages/blobs/tests/{unit,property,contract,integration,adversarial,perf,vectors}/`.
- `specs/004-blob-sync/contracts/*` is the source of truth for names, layouts and signatures; copy types from `blobs-api.ts` into the package rather than redesigning. Byte layouts in `blob-format.md` and `blob-protocol.md` are normative.
- "Existing" test helpers (`testCore`, `peers`, `memoryTransport`, `secureNode`, `hubTransport`) live in `packages/testkit/src/`.

---

## Phase 1: Setup (Shared Infrastructure)

- [ ] T001 Scaffold `packages/blobs` (`@sync/blobs`) with `package.json` (same shape as `packages/modules/package.json`: `main`/`types` and `exports` for `.` (`./src/index.ts`) and `./ref` (`./src/ref.ts`, a pure re-export of `BlobRef`, `validateRef`, `extractRefs` from `src/format/ref.ts` with no crypto or storage imports), `@sync/core` and `@sync/spaces` as peerDependencies, NO runtime `dependencies`), `tsconfig.json` and an empty `src/index.ts`
- [ ] T002 [P] Add `@sync/blobs` and `@sync/blobs/ref` (`packages/blobs/src/ref.ts`) to `paths` in `tsconfig.base.json`; add root npm scripts `test:blobs` (`vitest run packages/blobs`) and `test:blobs:adversarial` (`vitest run packages/blobs/tests/adversarial`) in `package.json`; confirm `scripts/build.mjs` builds `@sync/blobs` for the browser and `npm run build` still passes
- [ ] T003 [P] Release-surface guard test in `packages/blobs/tests/unit/release-surface.test.ts`: `@sync/blobs` has zero runtime `dependencies`, no file under `packages/blobs/src/` imports `@sync/testkit`, and no file under `packages/relay-server/src/` imports `@sync/spaces` (the relay holds no keys, SC-003); `@sync/blobs/ref` imports nothing from `@sync/core`, `@sync/spaces` or other blobs files except `format/ref.ts`; extend `packages/modules/tests/unit/release-surface.test.ts` so the only import of `@sync/blobs` under `packages/modules/src/` is `@sync/blobs/ref` (plus `import type` of `Blobs` in the facade, T044)
- [ ] T004 [P] Add an `eslint.config.js` block banning `@sync/spaces` value imports (type-only allowed) inside `packages/blobs/src/` except `packages/blobs/src/crypto/keys.ts`, so key access stays in one reviewed file
- [ ] T005 [P] Create the empty folders `packages/blobs/tests/{unit,property,contract,integration,adversarial,perf,vectors}/` with a `packages/blobs/tests/README.md` noting that DOM tests start with `// @vitest-environment jsdom`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Amendments B-1, B-2, B-3 (core) and S-1 (spaces), the format, crypto, storage, protocol codec, and the reusable test suites. Every story needs these.

**CRITICAL**: No user story work starts until this phase is complete.

### 2a. Amendments and test suites (tests first)

See [contracts/amendments.md](./contracts/amendments.md).

- [ ] T006 [P] B-1 lane test in `packages/core/tests/integration/amendments/lane.test.ts`: a lane registered on two connected cores delivers a binary message intact (1 MiB, all byte values) and the JSON sync decoder never sees it; sync `hello` carries `lanes`; a peer whose `hello` lacks the magic is not in `peers()` and is never sent lane bytes; registering one magic twice throws; magics below `0x80` throw; a stray lane byte at a core without the lane is reported and the connection stays open; a lane message larger than `limits.maxMessageBytes` (default 4 MiB) is dropped and reported with the connection kept
- [ ] T007 [P] B-1 queue-independence test in `packages/core/tests/integration/amendments/lane-queue.test.ts` with a fake clock and a slow transport: a packet written while 20 lane messages of 256 KiB are queued reaches the peer after at most one lane message, not after all 20
- [ ] T008 [P] B-2 test in `packages/core/tests/integration/amendments/peers.test.ts`: the existing `core.peers()` summaries keep `key`, `transport`, `peerId`, `label` and gain `spaces`, `relay`, `maxMessageBytes`, `bulk`; `peer:ready` fires after `hello`; `peer:gone` on disconnect; a relay's wildcard Space is reported as `["*"]`; a newly announced Space updates the list
- [ ] T009 [P] B-3 test in `packages/core/tests/integration/amendments/applied-object.test.ts`: `onApplied` events carry `object` (the post-apply `SyncableObject`) for create, update, a last-writer-wins-losing update (reports the current object, the older value not applied), a parked packet applied later (reapply path) and delete (tombstoned object); consumers that ignore `object` are unaffected and the 002 spaces suites stay green
- [ ] T010 S-1 test (after T011, which creates `vectors/keys.json`) in `packages/spaces/tests/unit/blob-keys.test.ts`: `forWrite` returns the scope's current epoch keys, `forRead(scope, keyId)` returns older epochs after rotation, a device never granted epoch N gets `undefined`, a share scope gives share keys (not Space keys), derived `CryptoKey`s are non-extractable, `onKeysChanged` fires when `putEpochKey` stores a key; KAT for the HKDF output against `packages/blobs/tests/vectors/keys.json` (shared file)
- [ ] T011 [P] Known-answer vectors in `packages/blobs/tests/vectors/`: `keys.json` (epoch key, scope ID, expected `encKey`/`macKey` bytes, from a fixed vector computed once with Node `crypto`), `blobs.json` (plaintexts of 1 byte, exactly 262144 bytes, 262145 bytes; expected nonces, chunk bytes, digests, manifest bytes, IDs; per `blob-format.md`) and a `README.md` stating how they were generated
- [ ] T012 [P] `laneContract()` in `packages/testkit/src/blobs/laneContract.ts`: for a transport factory, two endpoints (a) round-trip a 1 MiB binary lane message, (b) keep sync convergence working while 50 lane messages flow, (c) carry messages up to `capabilities.maxMessageBytes` unframed and larger ones up to `limits.maxMessageBytes` framed by the transport, (d) never deliver a lane message as a JSON error; export from `packages/testkit/src/index.ts`
- [ ] T013 [P] `blobStorageContract()` in `packages/testkit/src/blobs/blobStorageContract.ts` per the `BlobStorage` interface in `contracts/blobs-api.ts`: record put/get/merge idempotence; `putChunk` idempotent and `presentChunks` ascending; `deleteChunks` keeps the record and returns bytes; `deleteBlob` removes record, chunks and refs; `usedBytes` matches the sum of chunk sizes after any sequence of operations (property test); quota failure leaves state unchanged (`StorageQuotaError`); survives `close()` and reopen for persistent stores; `listBlobs` ordering by `lastAccessAt`
- [ ] T014 [P] Blob test harness in `packages/testkit/src/blobs/blobPeers.ts` (N secure devices from `secureNode`, optional relay from the hub transport, controllable latency, drop, reorder and duplicate, and a byte-corrupting tap) and `packages/testkit/src/blobs/tamper.ts` (flip one bit at a given offset in a manifest or chunk message); export both from the testkit index
- [ ] T015 [P] Lane codec tests in `packages/blobs/tests/unit/protocol-codec.test.ts`: round trip for every message type in `blob-protocol.md`; `get` with 0, 1 and 4096 ranges; rejects truncated bodies, a bad `idRaw` length, `nRanges` larger than the body, ranges with `lo > hi`, JSON bodies over 4 KiB, unknown type bytes (ignored, not thrown); property test that decode never throws for arbitrary bytes starting with `0xB1`

### 2b. Amendments (implementation)

- [ ] T016 B-1: add `hello.lanes?: number[]` to the message types and decoder (unknown fields still ignored) in `packages/core/src/sync/messages.ts`; create `packages/core/src/sync/lane.ts` (`LaneRegistry`, `Lane`, `LanePeer` per amendments.md); route messages whose first byte is a registered magic to the lane before the JSON decoder in `packages/core/src/sync/manager.ts`; advertise registered magics in the session's `hello` in `packages/core/src/sync/session.ts`; expose `core.lane(magic)` in `packages/core/src/core.ts` and `packages/core/src/types.ts`. Lane sends call `Transport.send` directly, never `Session.enqueue`; enforce `limits.maxMessageBytes` in the lane router on the message as delivered by the transport (drop and report, connection stays open) because the sync decoder's check does not run for lane messages; define `LanePeer` as `PeerSummary & { bulk: boolean }`
- [ ] T017 B-2: extend the existing `PeerSummary` and `core.peers()` (`packages/core/src/sync/channel.ts`, `manager.ts`) and add `peer:ready` / `peer:gone` events (extend `CoreEvent` in `packages/core/src/types.ts`) from session state; populate `spaces`, `relay`, `maxMessageBytes`, `bulk` (`capabilities.blobs`); edit `packages/core/src/sync/session.ts`, `packages/core/src/sync/manager.ts`, `packages/core/src/core.ts`
- [ ] T018 B-3: add the optional `object` property to the `onApplied` event type in `packages/core/src/types.ts` and `packages/core/src/store/apply.ts` and set it from the post-apply `obj` at the existing emit point (`this.applied.emit({ env, body, source })`, including the reapply path); `packages/core/src/core.ts` passes it through; no behavior change (depends on T009)
- [ ] T019 [P] S-1: implement `blobKeys` in `packages/spaces/src/service/blobKeys.ts` per `blob-format.md#keys` (HKDF with `info = "sync-blob/1" || scopeId(16) || keyId(8)`, 64 bytes split into a non-extractable AES-GCM key and HMAC key), using `Keystore.rawKey`, `Keystore.epochs` and the existing `createKeyAccess` scope lookup (`scopeFor`); add an `onKeyStored` listener to `Keystore.putEpochKey` in `packages/spaces/src/keystore/keystore.ts`; expose `spaces.blobKeys` from `packages/spaces/src/service/api.ts` and `packages/spaces/src/service/install.ts`; export the `BlobKeys` type from `packages/spaces/src/index.ts`
- [ ] T020 Update `specs/001-sync-core/contracts/transport.ts` (mark `Transport.blob` reserved and unused, document `capabilities.blobs` as "separate bulk channel hint"), `specs/001-sync-core/contracts/sync-protocol.md` (additive `hello.lanes`, lane framing) and `specs/002-spaces-security-identity/contracts/spaces-api.ts` (`blobKeys`), then run `npm run test` and `npm run test:contract` and confirm gate S0 (the Phase 2 exit gate: no user-story task starts until it is green): T006 to T010 green, every 001, 002 and 003 test unchanged
- [ ] T021 [P] Run `laneContract()` for every existing transport: add it to `packages/transport-websocket/tests/` (new `lane.contract.test.ts`), `packages/transport-webrtc/tests/contract.test.ts` (mock RTC) and the memory transport tests in `packages/testkit/tests/` (new `lane.contract.test.ts`), including messages above the transport's `maxMessageBytes` up to `limits.maxMessageBytes` (framed by the transport), fixing any transport-side framing defect it reveals, in the transport's own `src/index.ts`

### 2c. Format, crypto, storage, protocol codec

- [ ] T022 [P] Format tests in `packages/blobs/tests/unit/format.test.ts` against `vectors/blobs.json`: manifest encode/decode round trip; `id = base64url(SHA-256(manifest))` (43 chars, unpadded); a manifest is rejected unless `fmt = 1`, `chunkBytes = 262144`, `size > 0`, `n = ceil(size/chunkBytes)`, length exactly `41 + 32n`, `n ≤ 65535` and `size ≤ maxBlobBytes`; reference validation per data-model.md (marker `$blob = 1`, `id` 43 chars base64url, `size` positive integer, `type` matching `^[\w.+-]+/[\w.+-]+$` and ≤ 127 chars, `keyId` 16 hex chars, `name` ≤ 255 chars, `space` and `scope` non-empty strings); unknown `$blob` versions are reported as `unsupported`, not invalid
- [ ] T023 [P] Crypto tests in `packages/blobs/tests/unit/crypto.test.ts` against `vectors/blobs.json`: sealed chunk bytes equal the vectors; open succeeds; flipping any bit of nonce, ciphertext, tag, or AAD input (index, size, scope, keyId) fails with `BlobIntegrityError`; identical plaintext, key and index give identical bytes; different index or different plaintext gives a different nonce (property test over generated chunks); a chunk sealed under epoch A cannot be opened with epoch B keys
- [ ] T024 [P] Define the shared constants and types in `packages/blobs/src/format/constants.ts` (`CHUNK_BYTES = 262144`, `FMT = 1`, `LANE_MAGIC = 0xB1`, limits) and copy the types from `contracts/blobs-api.ts` into `packages/blobs/src/types.ts` (`BlobStatus`, `BlobsConfig`, `BlobEvents`, `Blobs`, `BlobStorage`, `StoredBlob`, errors including `BlobTooLargeError`)
- [ ] T025 [P] Implement base64url helpers (reuse `b64urlEncode`/`b64urlDecode` from `@sync/core`) and the manifest codec (`encodeManifest`, `decodeManifest`, `manifestId`, `isWellFormed`) in `packages/blobs/src/format/manifest.ts`
- [ ] T026 [P] Implement `validateRef(value, limits)` and `extractRefs(fieldValue)` (walks objects and lists, depth ≤ 4, returns every value with `$blob`) in `packages/blobs/src/format/ref.ts`; this file also defines and exports `BlobRef`, imports nothing from other package files, and is re-exported by `packages/blobs/src/ref.ts` (the `@sync/blobs/ref` subpath used by `@sync/modules`)
- [ ] T027 Implement chunk sealing and opening (`sealChunk`, `openChunk`, nonce derivation, AAD, digests) over `BlobKeys` handles in `packages/blobs/src/crypto/chunk.ts`, and the only module allowed to touch `@sync/spaces` in `packages/blobs/src/crypto/keys.ts` (`getWriteKeys(space, obj)`, `getReadKeys(scope, keyId)`, `onKeysChanged`) (depends on T024, T025)
- [ ] T028 [P] Run `blobStorageContract()` against a new in-memory `BlobStorage` in `packages/blobs/src/storage/memory.ts` with its test `packages/blobs/tests/contract/storage-memory.test.ts`
- [ ] T029 [P] Implement the IndexedDB `BlobStorage` (database `sync-blobs-v1`; stores `blobs`, `chunks` keyed `${id}:${index}`, `refs`, `meta`; cached `usedBytes` counter; `QuotaExceededError` mapped to `StorageQuotaError` from `@sync/core`; `estimate()` via `navigator.storage`) in `packages/blobs/src/storage/indexeddb.ts` with test `packages/blobs/tests/contract/storage-indexeddb.test.ts` (fake-indexeddb)
- [ ] T030 Implement the lane message codec (`encodeMessage`, `decodeMessage`, bounds checks, unknown types returned as `{kind:'unknown'}`) in `packages/blobs/src/protocol/codec.ts` per `blob-protocol.md` (depends on T015, T024)

**Checkpoint**: Amendments in, format and storage proven by vectors and contracts. User story work can begin.

---

## Phase 3: User Story 1 - Attach a File Without Slowing Sync (Priority: P1)

**Goal**: A user attaches a large file to an object. The object syncs at once carrying only a reference; the file is encrypted and stored locally, and is offered to peers in the background. Other devices see a placeholder with size information.

**Independent Test**: Quickstart S1 and S2: attach a 100 MB blob on A; B sees the object and a `missing / not-requested` status within the packet-sync budget, packets are not delayed, and an offline attach is offered after reconnecting.

### Tests for User Story 1 (write first, must FAIL)

- [ ] T031 [P] [US1] Attach pipeline test in `packages/blobs/tests/unit/attach.test.ts`: attaching `Blob` of 0 bytes rejects; 1 byte, exactly 262144 and 262145 bytes match `vectors/blobs.json` (reference `id`, `size`, `type`, `scope`, `keyId`); `type` falls back to `blob.type` then `application/octet-stream`; the scope is the override share when the object is in one and the Space otherwise; peak memory stays under 4 chunks (instrumented reads, never a whole-file read); `AbortSignal` mid-way deletes the partial and rejects; `onProgress` is monotonic and reaches `total`; a file larger than `maxBlobBytes` rejects with `BlobTooLargeError` (carries `size` and `limit`) before reading any chunk (FR-012); a device with no key for the scope rejects with `BlobKeyError`
- [ ] T032 [P] [US1] Status test in `packages/blobs/tests/unit/status.test.ts`: `observe(ref)` for a locally attached blob is `available` with `replicas = 0`; for an unknown ID is `missing / not-requested` with `size` from the reference and `progress = 0`; subscribers are notified on change and never leak after unsubscribe; two observers of one ID share state
- [ ] T033 [P] [US1] Offer test in `packages/blobs/tests/integration/offer.test.ts` using `blobPeers()`: after `attach` on A and `core.create` with the reference, B receives the object packet and the encoded packet is under 1 KiB; A sends `offer {space, id, size}` to a connected peer sharing the Space and sends none to a peer in a different Space; an offline attach is offered after A connects (US1.3); B does not download anything it did not request (FR-011); no lane message goes to a peer that did not advertise the lane; incoming `stored` from a peer records a replica (cap 16, deduplicated); an incoming `offer` for a blob nobody requested is answered `stored` if it is complete locally and otherwise ignored, never an automatic `get` (FR-011)
- [ ] T034 [P] [US1] Packet-latency test in `packages/blobs/tests/perf/packet-latency.perf.test.ts` (fake clock, throttled memory transport, 100 MB blob queued for offer and pulled by a peer): p95 packet delivery latency during the transfer is at most 2× idle and at most 250 ms more (SC-001); resident chunk buffers stay under 16 MiB (R-13)
- [ ] T035 [P] [US1] `blob` field type tests in `packages/modules/tests/unit/blob-field.test.ts`: `checkSchema` accepts `{type:'blob', required?, accept?, maxBytes?}` and a `list` of `blob`; validation per `data-model.md` (shape, `size ≤ min(maxBytes, configured max)`, `accept` patterns such as `image/*` and exact types, junk values rejected with a readable reason); property-based oracle comparison between `validateFieldValue` and a naive reference validator; projection and migration treat the value as opaque JSON; a v1 schema without `blob` fields is unaffected
- [ ] T036 [P] [US1] Facade test in `packages/modules/tests/integration/blobs-facade.test.ts`: `ctx.blobs.attach` for a Space the module did not declare writable throws `AccessDeniedError`; `observe`/`request`/`open` on a reference whose `space` is not declared readable throw `AccessDeniedError`; a module declaring no Spaces has no `ctx.blobs`; with blobs disabled in the app config `ctx.blobs` is `undefined`
- [ ] T037 [P] [US1] Placeholder element test (`// @vitest-environment jsdom`) in `packages/blobs/tests/unit/sync-blob-element.test.ts`: `<sync-blob>` with a missing blob renders type, human-readable size and a "Download" button; `downloading` renders progress with `role="progressbar"` and `aria-valuenow`; `available` image types render an `<img>` from an object URL that is revoked on disconnect; non-image types render a link with the file name; `failed` renders the reason and a retry button; `$blob` version other than 1 renders "Unsupported attachment"

### Implementation for User Story 1

- [ ] T038 [US1] Implement the streaming attach pipeline in `packages/blobs/src/attach/attach.ts`: reject over-limit before reading with `BlobTooLargeError` (FR-012); `file.slice` one chunk at a time; seal, digest, write chunk under a partial attach ID; on the last chunk build the manifest and ID; promote the partial to a `StoredBlob` (`origin: 'local'`, `replicas: []`) or discard it if the ID already exists (dedup, R-02); delete partials on error or abort; record partials in `meta` and clean those older than 1 h at startup (depends on T027, T028, T029)
- [ ] T039 [P] [US1] Implement `BlobStatus` observables and the event emitter in `packages/blobs/src/status/status.ts` and `packages/blobs/src/status/events.ts` (typed `BlobEvents`; listener errors never break the engine)
- [ ] T040 [US1] Implement the peer table and the offer sender in `packages/blobs/src/transfer/peers.ts` (follows `core.lane(0xB1).peers()` and `onPeer`, exchanges blob `hello`, tracks `window`, `serve`) and `packages/blobs/src/transfer/offer.ts` (on peer up and after attach, offer blobs that have no `stored` from this peer, only for Spaces both sides sync) (depends on T016, T017, T030, T038)
- [ ] T041 [US1] Implement incoming `offer`, `stored` and `reject` handling and replica recording in `packages/blobs/src/transfer/replicas.ts`: `stored` adds the peer to the blob's `replicas` (cap 16, deduplicated, persisted); `reject` (`quota`, `too-large`, `space`, `busy`) stops offering that blob to that peer for the session; an incoming `offer` is answered `get` only when the blob was requested or matches the `prefetch` rule, `stored` when it is already complete locally, and is otherwise ignored; the offer sender in T040 reads the `replicas` written here, so build them together (depends on T030, T040)
- [ ] T042 [US1] Implement `createBlobs` in `packages/blobs/src/blobs.ts`: wires storage (IndexedDB default, injectable), `BlobKeys`, lane, config defaults from `contracts/blobs-api.ts`, `attach`, `observe`, `on`, `close`; export the public surface from `packages/blobs/src/index.ts` (depends on T038 to T040; later stories add the remaining methods)
- [ ] T043 [P] [US1] Add the `blob` field type to `FieldDef` in `packages/modules/src/schema/types.ts`, validation in `packages/modules/src/schema/fields.ts` (importing `BlobRef` and `validateRef` only from `@sync/blobs/ref`, the pure subpath; add `@sync/blobs` as an OPTIONAL peerDependency in `packages/modules/package.json` through `peerDependenciesMeta`, never a runtime `dependency`) and `checkSchema` in `packages/modules/src/schema/lint.ts`; update `specs/003-modules-app-assembly/contracts/schema.ts` with the new variant
- [ ] T044 [US1] Implement the `ctx.blobs` facade in `packages/modules/src/access/blobs.ts`, thread an optional `blobs` service through `packages/modules/src/host/context.ts`, `packages/modules/src/host/host.ts` and `packages/modules/src/app/` (`startApp` config `blobs?: BlobsConfig | false`), reusing `AccessDeniedError` and the declared-Space checks from `packages/modules/src/access/guard.ts`; the facade's `Blobs` type is an `import type` from `@sync/blobs` and the instance is injected through the app config
- [ ] T045 [P] [US1] Implement the `<sync-blob>` custom element in `packages/blobs/src/ui/sync-blob.ts` (placeholder, progress, render, retry, accessible labels) and register helper `defineSyncBlob(blobs, name = 'sync-blob')`; no framework

**Checkpoint**: US1 delivers attach, reference, placeholder and background offer. Independently testable with quickstart S1 and S2 (without fetch).

---

## Phase 4: User Story 2 - Fetch, Verify, and View (Priority: P1)

**Goal**: A device opens an object whose photo it lacks. The photo is requested, fetched from any peer or relay that has it, verified chunk by chunk, resumed after interruption, decrypted and shown. Relays store only ciphertext.

**Independent Test**: Quickstart S3, S4, S5, S9, S10 and S11: fetch over relay, WebRTC and a small-message transport; tamper with chunks; resume at 37 %; plaintext scan of the relay; key rotation and share isolation; quota mid-download; mixed-version peers.

### Tests for User Story 2 (write first, must FAIL)

- [ ] T046 [P] [US2] Serve and fetch protocol test in `packages/blobs/tests/integration/fetch.test.ts` using `blobPeers()`: `request` on B with the blob only on A yields `missing → downloading (progress rises) → available`; `toBlob` equals the original bytes; B sends `get` with `manifest` flag first then only missing ranges; at most `window` chunk messages outstanding per peer; a peer that lacks the blob answers `miss`; `reject {space}` when the Space is not shared; `cancel` stops serving; a blob requested while no source exists is `missing / no-source` and completes by itself when a holder offers (edge case: only copy on an offline device); a peer that reports Space `"*"` (a relay) counts as sharing every Space for offers and fetches
- [ ] T047 [P] [US2] Verification test in `packages/blobs/tests/adversarial/tamper.test.ts` using `tamper()`: a manifest whose hash is not the requested ID is rejected before any chunk request; a flipped bit in a chunk is rejected, discarded, counted against the peer and re-requested from a second source (US2.3) or the same one after back-off; a peer that fails three times for a blob is not asked again that session; a chunk with a valid digest but an invalid GCM tag fails at `open` with `BlobIntegrityError` and never yields plaintext; a chunk for an index beyond `n`, a duplicate, and a chunk of the wrong length are discarded; a manifest with `scopeId`/`keyId` that differs from the reference is rejected; all raise `blob:rejected`
- [ ] T048 [P] [US2] Tamper property test (SC-002) in `packages/blobs/tests/property/tamper.property.test.ts`: for generated blobs (1 B to 3 MiB) and any single bit flipped anywhere in the manifest or in any chunk message in transit, the final stored result is either the correct blob (the bad copy was re-fetched) or `failed / verification`, and never a blob with wrong bytes; 100% of generated tamper cases rejected, minimum 1000 cases
- [ ] T049 [P] [US2] Convergence property test in `packages/blobs/tests/property/transfer-order.property.test.ts`: with any reordering, duplication and drop-and-retry of `get`, `chunk`, `miss`, `offer` and `stored` messages between 2 to 4 peers, every requester ends with the identical verified blob and storage holds exactly one copy of each chunk
- [ ] T050 [P] [US2] Resume test (SC-004) in `packages/blobs/tests/integration/resume.test.ts`: drop the connection at 37 %, close and reopen the engine from the same storage, reconnect; assert zero `chunk` messages for indexes already stored (count on the lane), the final blob verifies; repeated for an interruption at an arbitrary chunk boundary (property, 50 runs); cancellation keeps verified chunks
- [ ] T051 [P] [US2] Multi-source and transport-size test in `packages/blobs/tests/integration/sources.test.ts`: two holders split the missing ranges; one dying mid-transfer is covered by the other; a transport with `maxMessageBytes` 20 KiB and latency (framed by the transport) still completes; WebRTC mock peer and relay peer both work
- [ ] T052 [P] [US2] Key and scope test in `packages/blobs/tests/integration/keys.test.ts` using secure nodes: after a key rotation the member holding all epochs opens a blob written before and one written after; a removed member cannot fetch or open the post-rotation blob (`failed / no-key`) but opens one already downloaded; an override-share blob can be fetched by a Space member outside the share as ciphertext only, `open` fails with `no-key` and no plaintext is produced; a blob in `failed / no-key` becomes `available` when the missing epoch key arrives, without refetching; a blob attached before its object moved into an override share stays readable under the Space key (spec edge case, documented parity)
- [ ] T053 [P] [US2] Quota test in `packages/blobs/tests/integration/quota.test.ts` with a storage wrapper that throws `StorageQuotaError` after N bytes: status `failed / quota`, verified chunks kept, `blob:failed` emitted, a later `request` resumes after space is freed; with `evictOnQuota: true` and an evictable blob the fetch completes; with defaults nothing is evicted
- [ ] T054 [P] [US2] On-demand and prefetch test in `packages/blobs/tests/integration/on-demand.test.ts` (FR-011): an applied packet with a reference starts no download by default; with `prefetch: ref => ref.size < 2e6` small blobs download automatically and large ones do not; `request` joins an in-flight fetch instead of duplicating it; `priority: 'high'` is served before `'low'`
- [ ] T055 [P] [US2] Open-stream test in `packages/blobs/tests/unit/open.test.ts`: `open` decrypts chunk by chunk (peak memory under 4 chunks), `fetch: false` rejects with `BlobNotLocalError` when missing, `fetch: true` waits for the download, `toBlob` matches the original and has the reference `type`, aborting the stream releases the lease, a corrupted stored chunk aborts the stream with `BlobIntegrityError`
- [ ] T056 [P] [US2] Relay tests in `packages/relay-server/tests/blob-relay.test.ts`: the relay answers `offer` with `get` when within caps and verifies the manifest hash equals the offered ID; rejects a mismatching manifest, a chunk failing its digest, a blob over `maxBlobBytes` (`too-large`), over per-Space or total caps (`quota`), and an offer for a Space the peer did not declare (`space`); serves `get` to a second client; persists to disk and serves after a restart; evicts by idle TTL (default 90 days since last use) and oldest-first over the cap (spec FR-008 clarification); a client that finds the relay lacks a blob it holds re-offers it on connect; `authorize(space, peer)` hook can refuse
- [ ] T057 [P] [US2] Plaintext scan test (SC-003) in `packages/blobs/tests/integration/relay-plaintext.test.ts` using `secureNode` and the relay: attach a file containing a known marker, let the relay store it, then scan the relay's data directory, its in-memory structures and every lane byte it saw; the marker never appears; also assert `packages/relay-server` has no import of `@sync/spaces` (reuses T003)
- [ ] T058 [P] [US2] Mixed-version test in `packages/blobs/tests/integration/mixed-versions.test.ts`: one 001/002 peer without the lane and two blob peers in one Space: packets converge on all three, the blob pair transfers, the plain peer stores the reference as an ordinary field and is never sent a lane byte; a peer advertising blob `hello.v ≠ 1` is treated as having no blob lane
- [ ] T059 [P] [US2] Flood test in `packages/blobs/tests/adversarial/flood.test.ts` (write before T061): per peer, more than 256 pending requested ranges or more than 64 `offer` messages per second (sliding window) are answered `reject {busy}` (excess offers are dropped); a legitimate 1 GiB fetch (4096 chunks, coalesced into `get` messages of at most 256 ranges) is never rejected; normal transfers are unaffected

### Implementation for User Story 2

- [ ] T060 [US2] Implement the verifier (manifest then chunk then store) in `packages/blobs/src/transfer/verify.ts` per `blob-format.md#verification`, returning typed rejections and counting per-peer failures (depends on T025, T027)
- [ ] T061 [US2] Implement the responder in `packages/blobs/src/serve/serve.ts`: answer `get` with `manifest`, `chunk`, `miss`; check the Space is shared; serve only verified chunks; yield to the event loop between chunks; never queue more than `window` chunks per peer; honor `serve: false` and `cancel`; update `lastAccessAt`; enforce the per-peer limits in `blob-protocol.md` Rules (at most 256 pending requested ranges and 64 `offer` per second, excess answered `reject {busy}`; test: T059), where a relay's `"*"` counts as listing every Space (depends on T040, T060)
- [ ] T062 [US2] Implement the scheduler in `packages/blobs/src/transfer/scheduler.ts`: choose up to `maxSources` peers that share the Space (prefer peers that offered), split missing ranges (coalesced so one `get` carries at most 256 ranges), keep per-peer windows, re-request failed ranges from another source or after back-off, abandon a peer after three failures for one blob, resume from `presentChunks`, retry `no-source` whenever a peer comes up or offers; write each verified chunk before counting it; send `stored` to the peers that served or offered it once every chunk is stored; handle `StorageQuotaError` (keep chunks, set `failed / quota`; evict only when `evictOnQuota`) (depends on T040, T060)
- [ ] T063 [US2] Implement `request`, `cancel`, `open`, `toBlob`, the `prefetch` hook and the `failed / no-key` retry (subscribe to `onKeysChanged`) in `packages/blobs/src/blobs.ts`, `packages/blobs/src/transfer/request.ts` and `packages/blobs/src/crypto/open.ts` (stream decrypt, lease counting); update status and events accordingly (depends on T062, T061)
- [ ] T064 [P] [US2] Add `onLane(magic, handler)`, `sendLane(peerId, bytes)` and per-peer declared Spaces to `RelayHub` in `packages/relay-server/src/relayHub.ts` (additive; includes the `hello.lanes` advertisement when a lane handler is registered)
- [ ] T065 [P] [US2] Implement `FileBlobStorage` (a Node `BlobStorage`: `<dir>/<id[0..2]>/<id>/{manifest,<index>}`, atomic writes via temp file and rename, index rebuilt at startup) in `packages/relay-server/src/fileBlobStorage.ts`, and run `blobStorageContract()` against it in `packages/relay-server/tests/file-blob-storage.test.ts`
- [ ] T066 [US2] Implement `BlobRelay` in `packages/relay-server/src/blobRelay.ts` (structural verification only, caps `maxBlobBytes`/`perSpaceBytes`/`totalBytes`, idle TTL default 90 days and oldest-first eviction, optional `authorize`) and enable it from `packages/relay-server/src/server.ts` via options and environment variables (`BLOB_DIR`, `BLOB_MAX_BYTES`, `BLOB_TTL_DAYS`, `BLOB_TOTAL_BYTES`); document the options in `packages/relay-server/README.md` (depends on T064, T065)
- [ ] T067 [US2] Add a re-offer rule to the offer sender in `packages/blobs/src/transfer/offer.ts`: on connecting to a relay, offer local blobs of shared Spaces the relay answers it lacks, so evicted relays are repopulated (R-08; reads `replicas` from T041)

**Checkpoint**: US2 delivers verified, resumable fetch from any peer and a ciphertext-only relay cache. Independently testable with quickstart S3, S4, S5, S9, S10, S11.

---

## Phase 5: User Story 3 - No Duplicate Storage (Priority: P2)

**Goal**: The same file in a Space is stored and transferred once, and blobs that no object references are removed locally after the retention window.

**Independent Test**: Quickstart S6 and S7: attach one file to two objects (one stored copy, one transfer); delete the object, compact, advance the clock, and the blob is collected; undo before compaction keeps it.

### Tests for User Story 3 (write first, must FAIL)

- [ ] T068 [P] [US3] Dedup test in `packages/blobs/tests/integration/dedup.test.ts`: attaching identical bytes twice in one Space returns identical references and keeps one `StoredBlob` and one chunk set; on B both objects resolve to one fetch and one transfer (the count of lane `chunk` messages equals the chunk count); identical bytes in a different Space or after a key rotation give a different ID (per-scope, per-epoch dedup); an attach that turns out to duplicate leaves no partial behind
- [ ] T069 [P] [US3] Reference index test in `packages/blobs/tests/unit/refs.test.ts`: references are found at the top level, nested in an object and in a list; index entries follow create, update (reference replaced) and delete of objects; tombstoned objects still hold references until compacted; the index is rebuilt from object state when its `version` in `meta` differs, and the rebuilt index equals the incrementally maintained one (property test over random packet sequences)
- [ ] T070 [P] [US3] GC test in `packages/blobs/tests/integration/gc.test.ts` with a fake clock: delete the last referencing object, compact, advance past `retentionMs` (default 30 days), `collect()` deletes the record and chunks and emits `blob:deleted`; undo or edit-resurrect before compaction restores the reference and the blob is untouched; `unreferencedAt` clears when a reference reappears; an attach never referenced is deleted after `orphanGraceMs` (default 24 h) and one referenced in time is kept; a blob referenced by two objects survives deleting one

### Implementation for User Story 3

- [ ] T071 [US3] Implement the reference index in `packages/blobs/src/refs/index.ts`: subscribe to the core's `onApplied` hook and read the post-apply `object` it carries (B-3, T018), never the packet's own fields, because last-writer-wins means an applied packet may not change state, maintain `refs` in storage, rebuild via `scanApplied` when `meta.refsVersion` differs, set and clear `unreferencedAt`, never authoritative (depends on T026, T029, T018)
- [ ] T072 [US3] Implement GC and orphan handling in `packages/blobs/src/refs/gc.ts` (`collect()`, a timer that runs in idle slices of at most 50 blobs, `retentionMs`, `orphanGraceMs`, emits `blob:deleted`) and expose `collect()` and `reindex()` in `packages/blobs/src/blobs.ts` (depends on T071)

**Checkpoint**: US3 complete. Independently testable with quickstart S6 and S7.

---

## Phase 6: User Story 4 - Control What's Kept on the Device (Priority: P3)

**Goal**: A device with little space keeps a storage budget, evicts the least recently used unpinned blobs that are safely copied elsewhere, re-fetches them on demand, and lets the user pin blobs to keep them offline.

**Independent Test**: Quickstart S8: fill a budget, verify LRU eviction, pins and not-yet-replicated copies are kept, evicted blobs re-fetch without a manifest round trip.

### Tests for User Story 4 (write first, must FAIL)

- [ ] T073 [P] [US4] Eviction test in `packages/blobs/tests/integration/eviction.test.ts`: with `budgetBytes` set and the budget exceeded, evict the least recently used first (`lastAccessAt`, updated by `open` and serving); skip pinned blobs, blobs with `replicas.length < minReplicas` (including a blob attached offline and not yet confirmed), and blobs with an active lease or download; stop at the budget; eviction deletes chunks, keeps the record and manifest, status `missing / evicted`; with no budget configured nothing is ever evicted (spec Assumptions); `evict({targetBytes})` frees what it can and reports bytes; a pinned or unreplicated blob over budget emits `blob:storage` with usage above the budget
- [ ] T074 [P] [US4] Pin and policy test in `packages/blobs/tests/unit/policy.test.ts`: `pin`/`unpin` persist across restart and are never sent to peers (assert no lane or packet carries pin state); `minReplicas: 2` protects a blob confirmed by only one holder; `usage()` reports `usedBytes`, `blobs`, `pinnedBytes`, `unreplicatedBytes`
- [ ] T075 [P] [US4] Re-fetch test in `packages/blobs/tests/integration/refetch.test.ts`: an evicted blob is re-fetched on `request` and the first `get` omits the manifest flag (record kept); evicting then re-requesting repeatedly never corrupts the blob (property, 30 runs); eviction triggered by `storage:pressure` from the core quota monitor runs only when a budget is set

### Implementation for User Story 4

- [ ] T076 [US4] Implement the policy in `packages/blobs/src/policy/evict.ts` (LRU selection with the protection rules, run after writes and on `storage:pressure`, idle-sliced) and `packages/blobs/src/policy/pins.ts` (device-local pins; reads the `replicas` written by T041); expose `pin`, `unpin`, `usage`, `evict` in `packages/blobs/src/blobs.ts`; emit `blob:evicted` and `blob:storage` (depends on T062, T041)
- [ ] T077 [US4] Wire `lastAccessAt` updates and leases into `open` (T063) and `serve` (T061) in `packages/blobs/src/crypto/open.ts` and `packages/blobs/src/serve/serve.ts`, and make `<sync-blob>` show a "Keep on this device" toggle bound to `pin`/`unpin` in `packages/blobs/src/ui/sync-blob.ts`

**Checkpoint**: All four stories complete.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [ ] T078 [P] Add an optional `photo` field (`{type:'blob', accept:['image/*']}`) to the todo type and render it with `<sync-blob>` in `packages/sample-app/modules/todo/index.ts`; enable blobs in `packages/sample-app/app.config.ts`; extend `packages/sample-app/tests/modules.contract.test.ts` for the new field
- [ ] T079 [P] Playwright e2e in `tests/e2e/blobs.spec.ts` (quickstart S12): static-host sample app and a localhost relay with `BLOB_DIR`; context A attaches a photo offline, reconnects; context B sees the placeholder first and the photo after `request`; stop the relay and confirm a second request between two peers over mock WebRTC; entry page changes in `tests/e2e/pages/` as needed; also extend `tests/e2e/latency.spec.ts` with a case measuring packet delivery latency between two browser contexts while a 100 MB blob transfers (SC-001, budget from T034)
- [ ] T080 [P] Perf and memory benchmarks in `packages/blobs/tests/perf/attach.bench.ts`: attach throughput (≥ 20 MB/s desktop, ≥ 5 MB/s at 4× CPU throttle), peak memory ≤ 16 MiB above baseline for 100 MB attach and fetch, reference index update < 1 ms per applied packet, GC and eviction slices stay under 16 ms; record numbers and any shortfall in `validation.md`
- [ ] T081 [P] Security review note `specs/004-blob-sync/security-review.md`: deterministic-nonce argument and test links, equality leak within a scope and epoch, relay junk-storage residual risk and caps, DoS considerations for `get`/`offer` floods (the per-peer limits in `blob-protocol.md` Rules, implemented in T061 and tested by T059; document them), key-handling surface (only `crypto/keys.ts`), what a removed member can and cannot do
- [ ] T082 [P] Write `docs/blobs.md` (adding a `blob` field and `<sync-blob>` to a module in under 15 minutes, `BlobsConfig` reference, budget and pins, relay options, threat notes and limits, migration notes for apps using override shares) and update `README.md` and `packages/relay-server/README.md`
- [ ] T083 [P] Add a short `packages/blobs/README.md` describing the package surface, the storage contract and how to add a `BlobStorage` implementation (OPFS is the noted future option)
- [ ] T084 Constitution gate review: confirm Principles I to VIII against the implementation (offline attach and open tested, one apply path untouched, lane contract passes on every transport, relay has no keys, static-hosted e2e green, contracts suites in testkit); update `plan.md` if anything changed, and record in `validation.md`
- [ ] T085 Run quickstart scenarios S1 to S12 and the module-authoring check, then run `npm run typecheck`, `npm run lint`, `npm run test`, `npm run test:contract`, `npm run test:blobs`, `npm run e2e`; write `specs/004-blob-sync/validation.md` with results, measured numbers against targets, and any known gap stated plainly (depends on all earlier tasks)

---

## Dependencies & Execution Order

### Phase dependencies

- **Setup (Phase 1)**: none.
- **Foundational (Phase 2)**: after Phase 1. 2a tests can all be written in parallel; T016, T017 and T018 (core) are independent of T019 (spaces); 2c needs T024 and then T025 to T027; T028 and T029 need only T024 and the storage contract (T013). BLOCKS all user stories.
- **US1 (Phase 3)**: after Phase 2.
- **US2 (Phase 4)**: after Phase 2 and T038 to T042 from US1 (real attached blobs, peers, `createBlobs`). The relay tasks T064 to T066 are independent of US1 and can start right after Phase 2.
- **US3 (Phase 5)**: after Phase 2 and T038 (attach dedup). Independent of US2 and US4.
- **US4 (Phase 6)**: after T062 (scheduler) and T063 (open) from US2.
- **Polish (Phase 7)**: after the stories you want shipped. T085 is last.

### Within each story

Tests first and failing, then format/storage/protocol pieces, then engine wiring, then module and UI integration.

### Parallel opportunities

- Phase 1: T002 to T005 together.
- Phase 2a: T006 to T015 together (different files, except T010 which needs the vectors from T011); T019 in parallel with T016 and T017.
- Phase 2c: T022 to T026 together; T028 with T029.
- US1 tests T031 to T037 together; T039, T043, T045 in parallel with the pipeline work.
- US2 tests T046 to T058 and T059 together; T064 and T065 in parallel with T060 to T063.
- US3 tests T068 to T070 together. US3 and US4 can be built in parallel by different people once US2 is done.
- Polish T078 to T083 together.

### Parallel example: Phase 2a

```text
Task: "B-1 lane test in packages/core/tests/integration/amendments/lane.test.ts"        (T006)
Task: "S-1 blob keys test in packages/spaces/tests/unit/blob-keys.test.ts"               (T010)
Task: "laneContract() in packages/testkit/src/blobs/laneContract.ts"                      (T012)
Task: "blobStorageContract() in packages/testkit/src/blobs/blobStorageContract.ts"        (T013)
```

---

## Implementation Strategy

### MVP first (US1 only)

1. Phase 1 and Phase 2 (amendments, format, storage). Gate S0: T020 passes with all 001 to 003 tests unchanged.
2. Phase 3 (US1): attach, reference, placeholder, background offer, `blob` field type.
3. Stop and validate with quickstart S1 and S2. This alone gives apps attachments that never slow sync, but peers cannot yet download them, so US2 is the real minimum for a useful release.

### Incremental delivery

1. Setup and Foundational: the lane and formats are proven by vectors and contract suites.
2. US1: attach and offer. Validate S1, S2.
3. US2: fetch, verify, resume, relay, rotation and share isolation. Validate S3 to S5, S9 to S11. This is the first shippable release (US1 + US2, both P1).
4. US3: dedup and GC. Validate S6, S7.
5. US4: budget, LRU, pins. Validate S8.
6. Polish: sample app, e2e, benchmarks, security review, docs, validation.

### Notes

- Do not change the packet envelope, signing, or the 002 codec; the only wire change is the additive `hello.lanes` and the lane messages.
- Keep `@sync/blobs` and `@sync/relay-server` free of runtime dependencies. `@sync/modules` imports `@sync/blobs` only through the pure `@sync/blobs/ref` subpath (optional peerDependency; T001, T002, T003, T043).
- Each amendment is additive and has a compatibility note in `contracts/amendments.md`; if implementation shows an amendment needs more than described (for example B-3, the `onApplied` payload, used by T071), update the contract in the same change.
- Never store plaintext: the blob store holds ciphertext chunks only, and the relay never imports key code.
