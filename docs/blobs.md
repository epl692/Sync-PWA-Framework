# Attachments (blobs)

Photos and files are attached to objects as **blobs**: encrypted on the device, split into chunks, and moved between
devices separately from packets, and only when someone asks for them. An object that carries a photo syncs at once;
the photo follows on request.

Specification: `specs/004-blob-sync`. Package: `@sync/blobs`.

## How it fits together

- A blob is **not** an object. The object holds a small **reference** in an ordinary field; the bytes are immutable
  ciphertext in a separate store, fetched from any peer or relay that has them.
- The reference is `{ $blob: 1, id, size, type, space, scope, keyId, name? }`. `id` is the hash of the blob's manifest
  (a list of per-chunk digests), so any peer, even an untrusted relay, can serve the bytes and the receiver still
  verifies every chunk.
- Blobs are encrypted with a key derived from the epoch key of the object's Space, or of its override share, so a
  Space member outside the share can store and serve the ciphertext but never read it.

## Using blobs in a module

1. Declare the field with the `blob` type (or a list of blobs):

   ```ts
   fields: {
     title: { type: 'string', required: true },
     photo: { type: 'blob', accept: ['image/*'], maxBytes: 20 * 1024 * 1024 }, // accept and maxBytes are optional
     gallery: { type: 'list', of: 'blob', maxItems: 12 },
   }
   ```

2. Attach in a view or feature through `ctx.blobs` (present when the app enables blobs and the module has a type to
   attach to). Every call is checked against the Spaces the module declared, like `ctx.data`:

   ```ts
   const ref = await ctx.blobs.attach(file, { space: item.space, obj: item.id });
   await ctx.data.update(item.id, { photo: ref });
   ```

   `attach` works offline and resolves once the file is encrypted and stored here; uploading is a background step.
   It rejects with `BlobTooLargeError` (carrying `size` and `limit`) before reading anything when the file is over the limit.

3. Show it. `<sync-blob>` renders a placeholder (type and size), progress, then the content (image, audio, video or
   a download link), a retry button on failure, and a "Keep on this device" toggle:

   ```ts
   const el = document.createElement('sync-blob');
   el.ref = item.fields.photo;
   ```

   Or observe a blob yourself: `ctx.blobs.observe(ref)` returns `{ get(), subscribe() }` with
   `state: 'missing' | 'downloading' | 'available' | 'failed'`, `progress`, `reason`, `pinned` and `replicas`.
   `request(ref)` starts a download, `toBlob(ref)` gives the bytes, `open(ref)` a `ReadableStream`.

A module cannot import `@sync/blobs` (the build refuses it); everything it needs is on `ctx.blobs`.

## Turning blobs on in an app

The app, not a module, creates the engine, because it needs the open core:

```ts
// app.config.ts
import { createBlobs, defineSyncBlob } from '@sync/blobs';

export default {
  // ...
  async blobs({ core, spaces }) {
    const blobs = await createBlobs({ core, keys: spaces!.blobKeys, config: { budgetBytes: 500 * 1024 * 1024 } });
    defineSyncBlob(blobs); // defines <sync-blob>
    return blobs;
  },
} satisfies AppConfig;
```

`@sync/modules` imports only `@sync/blobs/ref` (the pure reference types and validator, a few hundred bytes), so
`@sync/blobs` must be installed for a build that includes `@sync/modules`, even if the app never calls `createBlobs`.

## Configuration (`BlobsConfig`)

| Option | Default | Meaning |
|---|---|---|
| `maxBlobBytes` | 1 GiB (maximum 16 GiB) | Largest accepted attachment. |
| `budgetBytes` | none | Local ciphertext budget. **Unset means nothing is ever evicted.** |
| `minReplicas` | 1 | Evict a blob only after this many peers or relays confirmed they hold it. |
| `evictOnQuota` | false | On a storage quota error, free room by evicting before failing. |
| `retentionMs` | 30 days | A blob is deleted this long after its last reference went (the history window, so undo still works). |
| `orphanGraceMs` | 24 hours | An attachment never referenced by any object is deleted after this. |
| `prefetch` | none | `(ref) => boolean`: download matching references automatically (for example small images). Otherwise downloads happen only on request. |
| `maxSources` | 2 | Peers asked in parallel for one blob. |
| `window` | 8 (32 on bulk transports) | Chunk requests outstanding per peer. |
| `serve` | true | Answer other devices' requests. |
| `requestTimeoutMs` | 30 000 | A chunk asked and not answered is asked again after this. |

Pins (`pin(ref)` / `unpin(ref)`) are per device and never synced. Eviction never touches a pinned blob, a blob whose
only known copy is here, a blob open in a stream, or one being downloaded. `usage()` reports bytes held, blobs,
pinned bytes and bytes with too few confirmed copies; `evict({ targetBytes })` frees what it can on demand.

## A relay that stores blobs

`@sync/relay-server` can keep ciphertext blobs on disk. It holds **no keys** and checks structure only (the manifest
hashes to the offered ID and every chunk matches its digest):

```bash
BLOB_DIR=./blobs BLOB_TTL_DAYS=90 BLOB_TOTAL_BYTES=50000000000 npm run relay-server
```

Options: `BLOB_DIR` (turns it on), `BLOB_MAX_BYTES`, `BLOB_TOTAL_BYTES`, `BLOB_PER_SPACE_BYTES`, `BLOB_TTL_DAYS`
(default 90). Or in code: `createRelayServer({ blobs: { dir, maxBlobBytes, perSpaceBytes, totalBytes, ttlMs, authorize } })`.

The relay is a **cache**, not an archive: it cannot see which objects reference what, so it deletes blobs idle for the
TTL and the least recently used first when a cap is reached. Devices that still hold a blob offer it again whenever
they connect and find the relay lacks it.

## Limits and things to know

- **Dedup is per Space (or share) and key epoch.** The same file in the same scope is stored and transferred once;
  after a key rotation the same file attached again is a new blob.
- **Moving an object into an override share does not re-encrypt an attachment made before the move.** It stays readable
  to the Space, as earlier packets do. To make it private, attach the file again after the object is in the share.
- A removed member keeps what they already downloaded and can still fetch new ciphertext from a relay, but cannot
  decrypt anything encrypted with an epoch key they were never given (`failed / no-key`).
- Within one scope and epoch, two files that share an identical 256 KiB chunk at the same position show identical
  ciphertext for it. Members can read everything in the scope anyway; a relay learns only that.
- Anyone who can connect to a relay and declare a Space can store (structurally valid) junk against that Space's
  quota. Set `perSpaceBytes`/`totalBytes` and, if needed, an `authorize` hook.
- Large `toBlob()` calls assemble the file in memory; for big files use `open()` and stream.
