# Data Model: Blob Sync

Nothing here is synced state except the **Blob Reference**, which is an ordinary field value inside an ordinary packet. Everything else is device-local, derived, or immutable ciphertext, so no new convergence rules exist (Principle III). Wire/binary layouts are in [contracts/blob-format.md](./contracts/blob-format.md); TypeScript shapes in [contracts/blobs-api.ts](./contracts/blobs-api.ts).

## Entities

### Blob Reference (synced, inside a packet)

A JSON value stored in an object field (top level, nested, or in a list).

| Field | Type | Rule |
|---|---|---|
| `$blob` | `1` | Marker and format version. Other values are kept and relayed but not interpreted (forward compatibility). |
| `id` | string | base64url (43 chars) SHA-256 of the manifest bytes. |
| `size` | integer | Plaintext bytes, `0 < size ≤ maxBlobBytes`. Must equal the manifest's `size`. |
| `type` | string | Media type, `^[\w.+-]+/[\w.+-]+$`, ≤ 127 chars. |
| `space` | string | Space ID the object lives in. |
| `scope` | string | Space ID or override share ID whose key encrypted the blob. |
| `keyId` | string | 16 hex chars of the epoch key (the `keyId` of 002). Selects the right epoch after rotations. |
| `name` | string? | Optional display file name, ≤ 255 chars. Not trusted for paths. |

Validation is a pure function of the value (the `blob` field type, M-1), so every peer agrees. A reference never contains bytes.

### Manifest (immutable, content-addressed)

Fixed binary layout; its SHA-256 is the blob ID. Contains `scopeId`, `keyId`, `size`, `chunkBytes`, and one SHA-256 digest per ciphertext chunk. Created at attach, transferred on request (`manifest` lane message), stored beside the chunks. It never changes.

### Chunk (immutable)

`index` (0-based) plus ciphertext bytes (`chunkBytes + 16`, last one shorter). Verified against `manifest.digests[index]` before it is stored or served.

### Blob Record (device-local, IndexedDB `blobs` store, key = `id`)

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Blob ID. |
| `manifest` | bytes | Verified manifest (kept after eviction). |
| `space`, `scope`, `keyId`, `size`, `type` | | Copied from the reference that first mentioned it. |
| `have` | bitset | Which chunk indexes are present (derived from the `chunks` store; cached for speed, rebuilt on open). |
| `origin` | `'local' \| 'remote'` | `local` = attached on this device. |
| `replicas` | string[] | Peer or relay keys that confirmed `stored` (device's belief; capped at 16). |
| `pinned` | boolean | Device-local keep flag. |
| `lastAccessAt` | ms | Updated on open and on serving a chunk. |
| `createdAt` | ms | |
| `unreferencedAt` | ms \| null | Set when `refs` becomes empty; cleared when a reference reappears. |
| `failure` | `{reason, at}` \| null | Last fetch failure. |
| `lease` | integer | In-memory only: open streams and active downloads; never evict while > 0. |

### Reference Index (derived, `refs` store)

`blobId → { objects: string[], since: ms }` plus a `version` in `meta`. Rebuildable from the object state at any time. Maintained from the core's applied-packet hook.

### Partial Attach (device-local, `meta`)

`attachId → { startedAt, chunksWritten }`. Present only while an attach is running or was interrupted; removed on completion, cancellation, or at startup (partials older than 1 h are deleted).

### Blob Status (observable, not stored)

Computed from the record plus the active transfer.

| `state` | Condition | Extra |
|---|---|---|
| `missing` | Record absent, chunks absent (never fetched, or evicted) | `reason?: 'evicted' \| 'no-source' \| 'not-requested'` |
| `downloading` | Active transfer | `progress` 0–1, `bytesDone` |
| `available` | All chunks present | `pinned`, `replicas` |
| `failed` | Last transfer ended in error | `reason: 'quota' \| 'too-large' \| 'verification' \| 'no-key' \| 'cancelled' \| 'unavailable'` |

The spec's "pinned" and "evicted" Blob States are the `pinned` flag and `missing/evicted`.

## State transitions (per device)

```
            request()/prefetch                 all chunks verified
  missing ───────────────────► downloading ─────────────────────────► available
     ▲  ▲                         │  │ ▲                                │  │
     │  │ no source: stays        │  │ └─ retry on peer/offer           │  │ evict (LRU, unpinned,
     │  │ missing (retried)       │  └──► failed (quota, no-key, ...)   │  │ replicated)
     │  └─────────────────────────┘          │ request() again          │  │
     └─────────────── evicted ◄──────────────┴──────────────────────────┘  │
                                                                           │
  attach() ─► (encrypting, no status) ─► available (origin local, replicas = [])
  GC: unreferencedAt older than retention ─► record and chunks deleted (from any state)
```

- A chunk is written only after its digest matches. A restart resumes by listing which chunks exist (SC-004).
- `no-key` (the device does not hold the epoch key for `keyId`) leaves the ciphertext stored but unreadable; it is re-evaluated when the keystore receives a grant (the spaces `key:received` event), which then moves `failed: no-key` to `available` without refetching.
- An evicted blob keeps its record and manifest, so re-fetch skips the manifest round trip.

## Validation rules (from the spec)

| Rule | Where enforced |
|---|---|
| FR-001 reference holds hash, size, type | `blob` field type |
| FR-002 encrypt before leaving the device | Attach pipeline; the lane only ever sees stored ciphertext chunks |
| FR-004/FR-006 per-chunk and whole verification | Receiver pipeline: manifest hash → chunk digest → GCM tag → total size |
| FR-007 dedup in a scope | Same ID ⇒ same record (R-02) |
| FR-008 GC after retention | GC job (R-09) |
| FR-009 budget, LRU, pin, protect unreplicated | Eviction policy (R-10) |
| FR-010 observable state | `observe()` |
| Key rotation | `keyId` in the reference and manifest selects the epoch key |
| Override share | `scope` is the share ID, key is the share's epoch key |

## Relationships

```
Object field ──holds──► Blob Reference ──id──► Manifest ◄─ commits to ─ Chunk[0..n-1]
                                │
                                └──► Blob Record (this device) ◄── Reference Index (object IDs)
```
