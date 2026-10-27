# Research: Blob Sync

All Technical Context unknowns are resolved here. Each entry is **Decision / Rationale / Alternatives**. Findings from reading the 001–003 code are marked *(code)*.

## R-01: Blob traffic uses a new binary lane in the core, not `chan` and not the `Transport.blob` hooks

- **Decision**: Add one small additive core amendment (B-1, [contracts/amendments.md](./contracts/amendments.md)): a **binary lane**. Messages whose first byte is a registered lane magic (blob lane = `0xB1`) bypass the JSON sync decoder and the per-peer packet queue and go to the lane's handler. Peers advertise lanes in `hello` (`lanes: number[]`, an additive field), so a lane message is only ever sent to a peer that said it understands it. The lane works over every existing transport because it uses `Transport.send`.
- **Rationale** *(code)*: The 002 channel (`chan`) base64-encodes its payload into a JSON message (+33% on the wire, and a 256 KiB chunk becomes a 350 KB JSON string to build and parse) and is sent through the session's packet queue (`session.ts` `enqueue`), so a 100 MB transfer would sit in line with packets. That breaks FR-003 and SC-001. The 001 `Transport.blob.sendChunk/onChunk` hook is unimplemented by any transport, carries no requests or control messages, and would need a different implementation per transport. A lane over `send` gets binary framing and queue independence with one core change.
- **Alternatives**: `chan` (rejected above); implementing `Transport.blob` on every transport (three implementations, no control plane, WebSocket still shares one TCP stream); a separate HTTP endpoint for blobs on the relay (breaks transport agnosticism, Principle IV, and does nothing for Bluetooth or WebRTC peers).
- **Consequence for the 001 contract**: `Transport.blob` stays declared but is **unused by v1** and marked reserved; `capabilities.blobs` is redefined as "has a physically separate channel for bulk data" and only raises the default window. FR-005 is met because the Transport contract suite gains `laneContract()` that every transport must pass (a large binary lane message survives intact and does not disturb packet sync).

## R-02: Content addressing with deterministic ("convergent within a scope") encryption

- **Decision**: Keys are derived per scope epoch (S-1): `blobKey = HKDF(epochKey, "sync-blob/1")` split into an AES-256-GCM key and an HMAC-SHA-256 key. A plaintext chunk `i` with SHA-256 digest `pd` is encrypted with nonce `HMAC(macKey, "n" || i || pd)[0..96 bits]`. The same bytes in the same scope and epoch therefore give identical ciphertext, an identical manifest, and an identical **blob ID** (SHA-256 of the manifest). Dedup is then a plain ID lookup (FR-007, US3) with no second pass over the file.
- **Rationale**: Random nonces make dedup impossible without decrypting. The keyed derivation means a server cannot test "does this relay hold file X" (the ciphertext depends on the scope key), and different Spaces never produce the same ID (the stated assumption). A nonce is repeated only for the same `(key, i, plaintext chunk)`, which yields the same ciphertext and is safe. HMAC is one-shot in Web Crypto (no streaming), so the nonce is derived from the chunk digest rather than a whole-file HMAC.
- **Known leak (documented, accepted)**: within one scope and epoch, two blobs that share an identical chunk at the same index show identical ciphertext for it; the relay can see that. Members can read everything in the scope anyway. After a key rotation the same file gets a new ID (dedup is per epoch).
- **Alternatives**: Random nonce plus a keyed plaintext tag stored in the reference (dedup only via local index, a second pass, and a stable tag visible to relays); plain SHA-256 of plaintext as ID (confirmation-of-file attack on relays; rejected for Principle V).

## R-03: Chunking, manifest, and verification

- **Decision**: Fixed 256 KiB plaintext chunks (the last one shorter). Stored chunk = `nonce(12) ‖ AES-GCM output` (+28 B over the plaintext). The **manifest** is `{scopeId, keyId, size, chunkBytes, chunks: SHA-256(stored chunk) × n}` in a fixed binary layout ([blob-format.md](./contracts/blob-format.md)); the **blob ID is the SHA-256 of the manifest bytes**. Receivers verify, in order: manifest hash equals the ID; each chunk's SHA-256 equals its manifest entry; AES-GCM tag (AAD binds scope, key, size, chunk size, index); then, at the end, total plaintext length equals `size`. Relays can do the first two without any key.
- **Rationale**: One identity (the ID) commits to every chunk, so any peer, even an untrusted relay, can serve the manifest and chunks and the receiver still verifies them (SC-002). Per-chunk digests give resumability and re-fetch of a single bad chunk from another peer (US2.3). 256 KiB keeps messages small enough to interleave with packets and fits every transport (WebRTC framing is in use, 8 MiB limits elsewhere), and the manifest for a 1 GiB blob is 128 KiB.
- **Limits**: `maxBlobBytes` default 1 GiB (manifest ≤ 128 KiB, ≤ 4096 chunks); configurable up to 16 GiB (manifest 2 MiB, still under the relay's 4 MiB message limit; checked at configuration time).
- **Alternatives**: Merkle tree (smaller manifest, but a flat list is simpler, and at these sizes the list fits in one message); bigger chunks (head-of-line blocking, worse resume granularity); smaller (more digests, more messages).

## R-04: Attach pipeline never holds the file in memory

- **Decision**: `attach(file)` streams `file.slice(i*C,(i+1)*C)` one chunk at a time: SHA-256 → derive nonce → AES-GCM → SHA-256 of ciphertext → write chunk to a temporary partial record. When the last chunk is done the ID is known; if it already exists locally the partial is discarded, else the record is promoted. The returned reference is available **after encryption completes** (not after upload). Working memory is a few chunks. Cancellation (`AbortSignal`) deletes the partial.
- **Rationale**: Files of hundreds of MB must not be buffered; the reference needs the ID, which needs the last chunk, so the attach call is the slow part and the UI shows its progress. Upload is always separate and later (FR-003).
- **Alternatives**: Two-pass hashing then encrypting (double read cost, no benefit after R-02); creating the object before the blob is encrypted (the packet would reference an ID that does not exist yet).

## R-05: Local storage is a separate IndexedDB database with its own contract

- **Decision**: A `BlobStorage` interface ([blobs-api.ts](./contracts/blobs-api.ts)) with three implementations: IndexedDB (`sync-blobs-v1`: `blobs`, `chunks`, `refs`, `meta`), in-memory (tests), and a Node file-system store (relay). It stores **ciphertext chunks**; decryption happens on open. A shared `blobStorageContract()` runs against all three (Principle VIII). It is not added to the 001 `StorageAdapter`.
- **Rationale** *(code)*: The 001 contract fixes six store names and gives cross-store atomic transactions the blob store does not need; a 100 MB blob inside the packet database would also distort its quota and compaction logic (`QuotaMonitor`). Storing ciphertext lets a device serve chunks to peers with no re-encryption, makes the relay and device paths identical, and keeps plaintext off disk beyond what the app itself caches.
- **Consequence**: Opening a blob decrypts chunk by chunk into a `ReadableStream`; `toBlob()` assembles in memory and is documented as best for files that fit comfortably (images). The app may cache an object URL.
- **Alternatives**: Extending `StorageAdapter` (a contract change affecting every implementation for no gain); OPFS (better for huge files, but not universal on older Safari; left as a future `BlobStorage` implementation behind the same contract).

## R-06: Fetching is on demand, with optional prefetch, from any number of peers

- **Decision**: A blob is fetched when the app calls `request(ref)` or observes it with `fetch: 'auto'`; the app may also set a `prefetch(ref) => boolean` policy (for example "images under 2 MB"). The scheduler asks up to `maxSources` (default 2) connected peers that share the Space, splitting missing chunk ranges between them, with a per-peer window of 8 outstanding chunks. A chunk that fails verification is dropped and re-requested from a different source when one exists (US2.3). Peers learn who holds what from `offer` messages and from simply trying: a peer that lacks the blob answers `miss`.
- **Rationale**: Spec says "fetching on demand" and a phone must not pull every photo. Windowed requests bound memory and keep the lane polite. No global "who has what" index to keep in sync.
- **Alternatives**: Eager fetch of everything (burns storage and bandwidth); a swarm tracker (extra distributed state).

## R-07: Upload is "offer to peers", and the relay pulls

- **Decision**: A device that holds a blob it has not yet replicated sends `offer {space, id, size}` to every lane peer that shares the Space, on connect and after attach. The receiver decides: the relay (`BlobRelay`) answers `get` if it lacks it and is within quota, otherwise `have`/`reject`; an ordinary peer answers `get` only if it wants the blob. A peer that finishes sends `stored {id}`, which increments the blob's `replicas` set (used by eviction protection).
- **Rationale**: One request/response shape (`get`) serves download, upload to a relay, and device-to-device. The receiver controls its own memory and quota. Offline attach (US1.3) needs nothing special: the offer happens when a peer appears.
- **Alternatives**: Push-on-attach (ignores receiver limits, wasted bytes to peers that already have it).

## R-08: The relay stores blobs as a cache of ciphertext

- **Decision**: `BlobRelay` plugs into the existing `RelayHub` lane hook (R-1 in amendments). It verifies structure only (manifest hash equals ID, chunk digests), enforces `maxBlobBytes`, per-Space and total byte caps, and that the offering peer declared the Space in `hello`. Storage is the Node file-system `BlobStorage`. Because the relay cannot see references it **cannot garbage-collect by reference**; it evicts by last-access time (default TTL 90 days, then LRU when over the cap). Devices that hold a blob and see the relay lack it re-offer on connect.
- **Rationale**: The relay is untrusted storage (Principle V) and sees only ciphertext, sizes and Space IDs, which it already sees for packets. Treating it as a cache means data survives because devices hold it, not because the relay never forgets, and it avoids a trust-requiring reference protocol. SC-003 is checked by scanning the relay's files for known plaintext.
- **Residual risk (documented)**: anyone who can connect and declare a Space can store structurally valid garbage in that Space's quota (the relay cannot verify AES-GCM). Per-Space caps and an optional `authorize(space, peer)` hook bound the damage; real authentication belongs to the relay operator (outside this spec, same as packets today).
- **Alternatives**: Relay GC from reference reports signed by members (new protocol and trust); no relay storage (spec scenario US2.4 and Assumptions require it).

## R-09: References, GC, and the "unreferenced" definition

- **Decision**: A reference is a JSON value `{ "$blob": 1, id, size, type, space, scope, keyId, name? }` stored in any object field (including inside lists and nested objects). `@sync/blobs` keeps a derived `refs` index (blob ID → object IDs) updated from the core's applied-packet hook (002 A-8 `onApplied`, reading the post-apply `object` it carries, B-3, never the packet's own fields, because last-writer-wins means an applied packet may not change state) and rebuilt with `scanApplied` if the index version differs. A blob is **referenced** while any object whose state is still held (live or tombstoned, not yet compacted away) contains it. When the last reference disappears the blob gets `unreferencedAt`; it is deleted when `now − unreferencedAt > retentionMs` (default 30 days, the 001 history window). An attached blob never referenced within `orphanGraceMs` (default 24 h) is treated as unreferenced from creation.
- **Rationale**: "Edit resurrects" and undo (001) mean a deleted object can return, so tombstones keep their blobs. The grace period covers "attach, then the user cancels the form". The index is derived state, never authoritative: wiping it and rescanning gives the same answer (Principle III, no mutable synced state).
- **Alternatives**: Reference counting in packets (a new mutation path); scanning all objects at GC time (simple, slow at scale; kept as the rebuild path only).

## R-10: Eviction, budget, pinning, and what counts as "only copy"

- **Decision**: `budgetBytes` (default unset = no eviction, per spec Assumptions). After writes and on `storage:pressure`, if over budget, evict least-recently-used blobs (`lastAccessAt`, updated on open and serve) that are not pinned, not being downloaded or open (leased), and whose `replicas` count is at least `minReplicas` (default 1, meaning a relay or peer confirmed with `stored`). Eviction deletes chunks, keeps the record and manifest (state `evicted`, observable as `missing`), so a re-fetch starts at once. Pins are **device-local** and not synced. A quota error mid-download keeps the verified chunks, marks the blob `failed: quota`, and emits an event; it does **not** evict on its own unless `evictOnQuota: true`.
- **Rationale**: Matches US4 and FR-009 while staying inside "default is no eviction". Protecting copies with no confirmed replica prevents data loss on a phone that attached a photo offline. A confirmed replica on a relay is a cache (R-08), so `minReplicas` is configurable to 2 for stricter apps.
- **Residual risk**: `replicas` is the device's belief; a peer may later lose it. The blob then shows `missing: no-source` and is retried whenever any peer offers it.

## R-11: Observability and the reference field in the schema

- **Decision**: `observe(ref)` returns a tiny store (`get()`, `subscribe()`) emitting `BlobStatus = { state: 'missing'|'downloading'|'available'|'failed', progress, bytesDone, size, reason?, pinned, replicas }` (FR-010). A `blob` field type is added to the 003 schema language (M-1) so references are validated like any field (shape, `size ≤ maxBlobBytes`, `type` matches `^[\w.+-]+/[\w.+-]+$`, ID format) and an app can declare `accept` media types and `maxBytes`. A thin `<sync-blob>` custom element renders placeholder (type, size), progress, then the content (image/video/audio/link) for the common case; apps may ignore it.
- **Rationale**: Validation is a pure function of the packet (003 R-04), so all peers agree and convergence is unaffected. Views get a placeholder state from one observable rather than inventing their own.
- **Alternatives**: Treat refs as untyped objects (no validation, any peer can plant junk sizes that mislead UIs); a heavy view library (out of scope, Principle VI).

## R-12: Module access goes through a facade

- **Decision**: `@sync/modules` gets an optional `blobs` service. `ModuleContext.blobs` is a facade whose `attach`, `request`, `open`, `observe`, `pin` check that the reference's `space` (or the `attach` target space) is within the module's declared access, using the same denial path and `AccessDeniedError` as the data facade (003 R-10). Blob operations are not available to a module that declares no Spaces.
- **Rationale**: Without this a module could read any blob it can name. This is the same API-level (not sandbox) guarantee 003 documents.

## R-13: Streaming, memory, and speed targets

- **Decision**: All APIs are stream-oriented: `attach(Blob | File)`, `open(ref) → ReadableStream<Uint8Array>`, `toBlob(ref)`. Targets (phone profile = 4× CPU throttle): attach ≥ 20 MB/s on desktop and ≥ 5 MB/s on the phone profile; resident memory during a 100 MB attach or fetch ≤ 16 MiB above baseline; packet delivery latency p95 during a 100 MB transfer ≤ 2× idle and ≤ 250 ms added (SC-001). Targets are measured in the perf suite and any shortfall is recorded in `validation.md`, not hidden.
- **Rationale**: AES-GCM and SHA-256 in Web Crypto are hardware-backed in all evergreen browsers; the cost is chunk bookkeeping, not crypto.

## R-14: Test strategy (Principle VIII, test-first)

- **Decision**: Contract suites in `@sync/testkit`: `blobStorageContract()` (all three stores) and `laneContract()` (all transports). Property tests (fast-check): any interleaving, duplication, and reordering of chunk and `get` messages ends in one correct blob; any single flipped byte in a manifest or chunk is rejected (SC-002 as 100% of generated cases); resume after an arbitrary interruption re-sends only missing chunks (SC-004). Integration with the real `openSecureCore` + testkit memory and relay transports; an adversarial set (tampered chunk, lying manifest, wrong-scope key, replayed offers, relay sending junk). Playwright e2e: two browser contexts through the relay, offline attach, reconnect. Tasks list every test before its implementation.
