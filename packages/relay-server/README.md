# @sync/relay-server

A reference relay. It speaks the sync protocol, stores and forwards **opaque** packets, and never decodes a
body, so it needs no keys. State is in memory: after a restart, clients resend what the relay lacks.

```bash
npm run relay-server        # ws://localhost:8787 (PORT=... to change)
```

Use `createRelayServer({ port })` from code. A convenience for testing and small deployments, not a required backend.

## Attachments (blobs)

With `BLOB_DIR` set (or `createRelayServer({ blobs: { dir } })`) the relay also stores **ciphertext blobs** on disk for
devices that attach photos and files (spec 004). It still holds no keys: it checks that a manifest hashes to the offered
ID and that every chunk matches its digest, and nothing more.

```bash
BLOB_DIR=./blobs BLOB_TTL_DAYS=90 BLOB_TOTAL_BYTES=50000000000 npm run relay-server
```

| Variable | Default | Meaning |
|---|---|---|
| `BLOB_DIR` | none (off) | Where blobs live. |
| `BLOB_MAX_BYTES` | 1 GiB | Largest blob accepted. |
| `BLOB_TOTAL_BYTES` / `BLOB_PER_SPACE_BYTES` | no cap | Caps on all blobs and per Space; the least recently used go first. |
| `BLOB_TTL_DAYS` | 90 | A blob nobody used for this long is deleted. |

The relay is a **cache**: devices that still hold a blob offer it again when they find the relay lacks it. From code,
`new BlobRelay(hub, { storage: await createFileBlobStorage(dir), authorize })` adds it to any `RelayHub`.

