# Implementation Plan: Blob Sync

**Branch**: `004-blob-sync` | **Date**: 2026-10-27 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/004-blob-sync/spec.md`

## Summary

Add encrypted, content-addressed binary attachments that sync lazily and separately from packets. An object field holds a small **reference** (`id`, size, type, scope, key ID); the bytes are chunked (256 KiB), encrypted on the device with keys derived from the object's Space or override-share epoch key, and moved over a new **binary lane** that works on every existing transport and relays ciphertext only. It plugs into the finished 001 core, 002 keys, and 003 modules without changing the packet format.

Technical approach (details in [research.md](./research.md)):

- **Binary lane (B-1)**: the one core change. Lane messages (`0xB1`) bypass the JSON decoder and the per-peer packet queue, so a 100 MB transfer cannot delay packets and nothing is base64-wrapped (R-01). Advertised through an additive `hello.lanes`, so older peers are never sent lane bytes.
- **Deterministic encryption within a scope (R-02)**: nonces derive from the key and chunk digest, so identical content gives an identical manifest and ID. Dedup is an ID lookup; a relay cannot confirm a guessed file; different Spaces never collide.
- **One identity commits to everything (R-03)**: blob ID = SHA-256 of a manifest of per-chunk ciphertext digests. Any peer, including an untrusted relay, can serve data and the receiver verifies manifest, each chunk, the AES-GCM tag, and the total size.
- **Streaming everywhere (R-04, R-13)**: attach reads one chunk at a time and never holds the file; open decrypts chunk by chunk.
- **Own storage, own contract (R-05)**: a separate IndexedDB database of ciphertext chunks, with memory and Node file-system implementations behind `blobStorageContract()`. The 001 `StorageAdapter` is untouched.
- **Pull model (R-06, R-07)**: devices `offer`; receivers `get` what they want and can take ranges from several peers; resume is "request only missing indexes". A relay is a ciphertext cache (R-08).
- **Derived, rebuildable bookkeeping (R-09, R-10)**: the reference index, GC, LRU eviction, pins, and replica counts are device-local state, never synced and never authoritative. Pins and budgets are per device.
- **Small additive amendments (B-1, B-2, B-3, S-1, M-1, R-1, T-1)** to core, spaces, modules, relay, and testkit, listed with compatibility notes in [contracts/amendments.md](./contracts/amendments.md).

## Technical Context

**Language/Version**: TypeScript 5.x strict, ES2022; Node 20 LTS for the relay and tooling.

**Primary Dependencies**:
- `packages/blobs` (`@sync/blobs`): **none at runtime** (Web Crypto, IndexedDB, `Blob.stream()`), depends on workspace packages `@sync/core` and a type-only view of `@sync/spaces` (`BlobKeys`).
- `packages/modules` gains an optional peerDependency on `@sync/blobs`, imported only through the pure `@sync/blobs/ref` subpath (types and `validateRef`); no runtime dependency.
- `packages/relay-server`: Node built-ins (`fs`, `crypto`) only; no new dependency.
- Dev/test: existing `vitest`, `fast-check`, `fake-indexeddb`, `@playwright/test`, `jsdom`.

**Storage**: New IndexedDB database `sync-blobs-v1` (`blobs`, `chunks`, `refs`, `meta`), ciphertext only; memory implementation for tests; Node file store for the relay (`<dir>/<id[0..2]>/<id>/{manifest,<index>}`). Object data and packets use the 001 stores unchanged.

**Testing**: Vitest for unit, contract, integration, adversarial. fast-check for chunk-order/duplication/tamper/resume properties. `fake-indexeddb` for the browser store. Playwright (Chromium) for two-context, relay, offline-attach e2e. New testkit suites `laneContract()` and `blobStorageContract()` (Principle VIII). Known-answer vectors for the format.

**Target Platform**: Evergreen browsers (Chrome, Edge, Safari incl. iOS, Firefox) with `Blob.stream`, Web Crypto, IndexedDB; Node 20 for the relay.

**Project Type**: Library monorepo: one new package, one relay extension, additive changes to four existing packages, plus a sample-app field.

**Performance Goals** (R-13; measured, shortfalls recorded in `validation.md`): attach ≥ 20 MB/s desktop and ≥ 5 MB/s phone profile; resident memory ≤ 16 MiB above baseline during a 100 MB attach or fetch; packet latency p95 during a 100 MB transfer ≤ 2× idle and ≤ 250 ms added (SC-001); resume re-sends zero completed chunks (SC-004); reference-index update < 1 ms per applied packet; GC and eviction scans O(blobs) and chunked into idle slices.

**Constraints**: Offline-first: attach and open of local blobs need no network; fetch and upload are background. No chunk is stored before its digest matches. Message size ≤ the smaller of the transport's and 001's limits. No runtime dependencies. Plaintext never touches disk (the store holds ciphertext) or the relay.

**Scale/Scope**: Blobs up to 1 GiB by default (configurable to 16 GiB; manifest ≤ 2 MiB); thousands of blobs per device; tens of GiB on a relay disk; a few peers per fetch.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | How the plan satisfies it |
|---|---|---|
| I. Offline-first | PASS | Attach encrypts and stores locally and works with no transport; upload is a background offer. Opening a local blob needs no network. Missing blobs show a placeholder, never block rendering. |
| II. Everything is a Syncable Object | PASS (justified, see Complexity Tracking) | The only synced datum is the reference, an ordinary field of an ordinary object. The bytes are immutable, content-addressed, referenced only from object fields; there is no mutable synced state outside the object model. |
| III. Packets are the only way state changes | PASS | Attaching, replacing, and removing an attachment are packets that change the reference. Blob storage is a set of immutable verified items (union, idempotent, order-free); the reference index, pins, replica counts, and eviction are local derived state. Property tests cover reorder, duplication, and resume. |
| IV. Transport agnostic | PASS | The lane rides `Transport.send`; no transport-specific code in `@sync/blobs`. `laneContract()` is required of every transport. |
| V. Zero-trust, E2E | PASS | Encrypted on the authoring device with per-scope keys derived (HKDF, S-1) from the Space's or share's epoch key before leaving it; relays hold ciphertext and verify only digests; every receiver verifies manifest, chunk, tag, and size; references live in signed, role-checked packets so peers cannot be tricked into trusting swapped bytes. Residual risks (junk storage on a relay, equality leaks within a scope) are stated in R-02 and R-08. |
| VI. Modular | PASS | New package; core gains only the generic lane. Modules reach blobs through a facade that enforces declared Space access, and `blob` is a schema field type. |
| VII. Static-hostable | PASS | No backend needed: devices exchange blobs over any transport; the relay is optional and only a transport target. Verified by the static-host e2e (S12). |
| VIII. Contract-tested, test-first | PASS | `laneContract`, `blobStorageContract`, vectors, property and adversarial tests; tasks put every test before its implementation. |

**Technical constraints**: strict TS; IndexedDB and Web Crypto only; zero runtime dependencies; native Web Components for the optional `<sync-blob>` element; the `blob` field type is part of the versioned schema language.

**Compatibility note (required by Development Workflow):** This feature adds an encryption format (`blob-aes-gcm/1`) and a lane to the sync `hello`, and leaves the packet envelope, signing, and 002 codec unchanged. Rules for older peers (no lane, never sent lane bytes; references remain valid field values) are in [contracts/blob-format.md](./contracts/blob-format.md#compatibility), [contracts/blob-protocol.md](./contracts/blob-protocol.md#compatibility), and [contracts/amendments.md](./contracts/amendments.md#overall-compatibility-summary-required-by-development-workflow). `Transport.blob` from 001 stays declared but unused (reserved).

**Post-design re-check (after Phase 1):** PASS. Items examined and justified rather than waived:
1. *Bytes live outside the packet log.* Required by the spec and by FR-003. Justified under Principle II in Complexity Tracking.
2. *Deterministic nonces.* Safe because a repeated nonce implies identical plaintext (R-02); known-answer vectors and a property test that distinct chunks never share a nonce in generated data back it.
3. *The relay cannot garbage-collect by reference or verify GCM tags.* It is a TTL/LRU cache with caps; devices are the source of truth (R-08).
4. *Content moved into an override share after attach stays readable under the old scope key.* Same as packets in 002; documented (blob-format Compatibility).
5. *The lane is the only core change that touches the message path.* It is additive, gated by `hello.lanes`, and covered by tests that older peers never see lane bytes.

## Project Structure

### Documentation (this feature)

```text
specs/004-blob-sync/
├── plan.md              # This file
├── research.md          # Phase 0: decisions, rationale, alternatives
├── data-model.md        # Phase 1: entities, status, state transitions
├── quickstart.md        # Phase 1: validation scenarios S1–S12
├── contracts/
│   ├── blobs-api.ts         # BlobRef, Blobs API, config, events, BlobStorage contract
│   ├── blob-format.md       # keys, chunking, nonce, manifest, ID, verification, compatibility
│   ├── blob-protocol.md     # lane framing and messages (hello, offer, get, manifest, chunk, miss, stored, reject, cancel)
│   └── amendments.md        # B-1, B-2, B-3 (core), S-1 (spaces), M-1 (modules), R-1 (relay), T-1 (testkit)
└── tasks.md             # Phase 2 (/speckit-tasks, not created here)
```

### Source Code (repository root)

```text
packages/
├── core/                    # AMENDED (B-1 to B-3): lane registry, hello.lanes, extended peer info, post-apply object on onApplied
├── spaces/                  # AMENDED (S-1): blobKeys (HKDF derivation, scope lookup, key-arrival event)
├── modules/                 # AMENDED (M-1): `blob` field type, optional ctx.blobs facade
├── relay-server/            # AMENDED (R-1): lane hook, BlobRelay, FileBlobStorage
├── testkit/                 # ADDED (T-1): laneContract, blobStorageContract, blobPeers harness, tamper helpers
├── blobs/                   # NEW  @sync/blobs (browser runtime, zero deps)
│   ├── src/
│   │   ├── format/          # manifest encode/verify, reference validation (also the pure `@sync/blobs/ref` subpath), constants, base64url
│   │   ├── crypto/          # chunk seal/open, nonce derivation, digests (uses BlobKeys)
│   │   ├── storage/         # BlobStorage interface, IndexedDB and memory implementations
│   │   ├── attach/          # streaming attach pipeline, partial cleanup, dedup by ID
│   │   ├── protocol/        # lane message codec (encode/decode, bounds checks)
│   │   ├── transfer/        # peer table, scheduler (sources, windows, ranges), verifier, resume
│   │   ├── serve/           # answering offer/get/cancel, yielding, caps
│   │   ├── refs/            # reference extraction, index, GC, orphan grace
│   │   ├── policy/          # budget, LRU eviction, pins, replicas, quota handling
│   │   ├── status/          # BlobStatus observables, events
│   │   ├── ui/              # <sync-blob> custom element (placeholder, progress, render)
│   │   ├── blobs.ts         # createBlobs composition
│   │   └── index.ts
│   └── tests/{unit,property,contract,integration,adversarial,perf,vectors}/
└── sample-app/              # AMENDED: todo gains an optional photo (`blob` field), shown with <sync-blob>
tests/e2e/blobs.spec.ts      # Playwright: two contexts, relay, offline attach, static host
docs/blobs.md                # using blobs in a module, config, relay setup, limits and threat notes
```

**Structure Decision**: A new package keeps blob logic out of the core (Principle VI) and lets apps that need no attachments ship without it. The only core change is the generic lane, which other bulk-data plugins could reuse. Storage is a separate database with its own contract so large binary data cannot interfere with packet storage, quota handling, or compaction. The relay extension lives in `relay-server` because it needs Node file access; it imports no key code.

**As built:** the implementation followed this plan with the small differences, additions to the contracts, defects found and measured budgets recorded in [validation.md](./validation.md).

## Complexity Tracking

| Item | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| Bytes stored outside the object model (Principle II) | Spec FR-003 and "lazy, separate" require bulk data not to travel in packets; a 100 MB value in a packet would block sync and bloat the log and snapshots | Embedding bytes in fields breaks SC-001 and compaction; making each chunk a Syncable Object would put large immutable data through the packet path and conflict logic for no convergence benefit. Mitigation: only the reference is state, bytes are immutable and verified by the ID that lives in a signed packet |
| New binary lane in the core (B-1) | Channel messages are base64 JSON in the packet queue (+33%, head-of-line); `Transport.blob` hooks have no implementations or control plane | A per-transport blob implementation triples the work and still shares a stream; `chan` fails FR-003/SC-001 |
| Deterministic nonce derivation | Dedup within a scope and a relay-verifiable ID require same content to give same ciphertext | Random nonces make FR-007 depend on a plaintext tag or local-only index and a second pass over the file |
| Separate `BlobStorage` contract and three implementations | Atomicity needs differ, sizes are large, and the relay must use the same code on disk | Extending `StorageAdapter` changes a contract all implementations must meet and mixes quota and compaction concerns |
| Own manifest and reference formats, no library | Zero runtime dependencies in shipped code | A Merkle or CAR library would be the first runtime dependency for ~200 lines of owned, vector-tested code |
