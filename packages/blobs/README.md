# @sync/blobs

Encrypted, content-addressed attachments (photos, files) that sync lazily and separately from packets.
No runtime dependencies. User guide: [docs/blobs.md](../../docs/blobs.md). Specification: `specs/004-blob-sync`.

```ts
import { createBlobs, defineSyncBlob } from '@sync/blobs';

const blobs = await createBlobs({ core, keys: spaces.blobKeys }); // IndexedDB storage by default
defineSyncBlob(blobs);                                            // <sync-blob>

const ref = await blobs.attach(file, { space, obj: item.id });    // encrypt and store here; works offline
await core.update(item.id, { photo: ref });                       // the reference is an ordinary field
await blobs.request(ref);                                         // fetch on demand, resumable, verified
const stream = await blobs.open(ref);                             // decrypted bytes, chunk by chunk
```

## Surface

- `createBlobs(options)`: `attach`, `observe`, `request`, `open`, `toBlob`, `cancel`, `pin`, `unpin`, `usage`, `evict`, `collect`, `reindex`, `on`, `close`.
- `defineSyncBlob(blobs, tag?)`: the `<sync-blob>` element.
- `@sync/blobs/ref`: the pure reference type and validator (`BlobRef`, `validateRef`, `extractRefs`), imported by `@sync/modules`.
- Storage: `createIndexedDbBlobStorage`, `createMemoryBlobStorage`, and the `BlobStorage` interface.
- Formats: `sealChunk`, `openChunk`, `encodeManifest`, `decodeManifest`, `manifestId`, and the lane message codec. Byte-level contracts: `specs/004-blob-sync/contracts/blob-format.md` and `blob-protocol.md`; known-answer vectors in `tests/vectors/`.

## Writing a storage implementation

Implement `BlobStorage` (ciphertext chunks `nonce ‖ ciphertext`, verified manifests, small records) and run the shared suite:

```ts
import { blobStorageContract } from '@sync/testkit';
blobStorageContract('my store', { async create() { return { storage, reopen, setQuota, teardown }; } });
```

`@sync/relay-server` has a Node file-system implementation. OPFS is a natural next one for very large files.

## How it is organised

| Folder | Role |
|---|---|
| `format/` | Reference, manifest, constants. Pure. |
| `crypto/` | Chunk sealing and opening; `keys.ts` is the only file that touches `@sync/spaces`. |
| `attach/` | The streaming attach pipeline. |
| `protocol/` | Lane message codec. |
| `transfer/` | Peer table, offers and replicas, the scheduler (sources, windows, verification, resume). |
| `serve/` | Answering other devices' requests, with flood limits. |
| `refs/` | Reference index, garbage collection, prefetch. |
| `policy/` | Budget, LRU eviction, pins, usage. |
| `status/`, `ui/` | Observable status; `<sync-blob>`. |
