/**
 * Streaming attach (research R-04): read one chunk at a time, seal it, store it under a partial ID, and when the last
 * chunk is done build the manifest, learn the blob ID and promote the partial. The file is never held in memory.
 */

import type { Engine } from '../engine';
import { CHUNK_BYTES } from '../format/constants';
import { unhex } from '../format/bytes';
import { chunkCount, encodeManifest, manifestId, plainLength } from '../format/manifest';
import type { BlobRef } from '../format/ref';
import { sealChunk } from '../crypto/chunk';
import type { AttachOptions, StoredBlob } from '../types';
import { BlobTooLargeError } from '../types';

const MEDIA_TYPE = /^[\w.+-]+\/[\w.+-]+$/;
const PARTIALS = 'partials';
const PARTIAL_MAX_AGE_MS = 60 * 60 * 1000;

type Partials = Record<string, number>;

async function registerPartial(e: Engine, id: string): Promise<void> {
  const p = (await e.storage.getMeta<Partials>(PARTIALS)) ?? {};
  p[id] = e.now();
  await e.storage.setMeta(PARTIALS, p);
}
async function forgetPartial(e: Engine, id: string): Promise<void> {
  const p = (await e.storage.getMeta<Partials>(PARTIALS)) ?? {};
  if (id in p) {
    delete p[id];
    await e.storage.setMeta(PARTIALS, p);
  }
}

/** At startup: delete partial attaches older than an hour (a live attach in another tab would be younger). */
export async function cleanPartials(e: Engine): Promise<number> {
  const p = (await e.storage.getMeta<Partials>(PARTIALS)) ?? {};
  let n = 0;
  for (const [id, at] of Object.entries(p)) {
    if (e.now() - at > PARTIAL_MAX_AGE_MS) {
      await e.storage.deleteChunks(id);
      delete p[id];
      n++;
    }
  }
  if (n) await e.storage.setMeta(PARTIALS, p);
  return n;
}

function randomId(): string {
  const b = new Uint8Array(12);
  globalThis.crypto.getRandomValues(b);
  return 'partial-' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

export async function attach(e: Engine, source: Blob, opts: AttachOptions): Promise<BlobRef> {
  const size = source.size;
  if (!Number.isSafeInteger(size) || size <= 0) throw new RangeError('cannot attach an empty file');
  if (size > e.cfg.maxBlobBytes) throw new BlobTooLargeError(size, e.cfg.maxBlobBytes);
  const type = (opts.type ?? (source.type || 'application/octet-stream')).toLowerCase();
  if (type.length > 127 || !MEDIA_TYPE.test(type)) throw new TypeError(`"${type}" is not a media type`);
  opts.signal?.throwIfAborted();

  const keys = await e.keys.forWrite(opts.space, opts.obj); // BlobKeyError when this device holds no key
  const partial = randomId();
  await registerPartial(e, partial);
  try {
    const n = chunkCount(size);
    const digests: Uint8Array[] = [];
    let done = 0;
    for (let i = 0; i < n; i++) {
      opts.signal?.throwIfAborted();
      const plain = new Uint8Array(await source.slice(i * CHUNK_BYTES, i * CHUNK_BYTES + plainLength(size, i)).arrayBuffer());
      const sealed = await sealChunk(keys, size, i, plain);
      await e.storage.putChunk(partial, i, sealed.stored);
      digests.push(sealed.digest);
      done += plain.length;
      opts.onProgress?.(done, size);
    }
    opts.signal?.throwIfAborted();

    const manifest = encodeManifest({ scopeId: keys.scopeId, keyId: unhex(keys.keyId), size, digests });
    const id = await manifestId(manifest);
    const now = e.now();
    const existing = await e.storage.getBlob(id);
    // Identical content in the same scope and epoch has the same ID: keep one copy (FR-007).
    await e.storage.moveChunks(partial, id);
    const rec: StoredBlob = existing
      ? { ...existing, complete: true, lastAccessAt: now, unreferencedAt: null }
      : {
          id,
          manifest,
          space: opts.space,
          scope: keys.scope,
          keyId: keys.keyId,
          size,
          type,
          origin: 'local',
          replicas: [],
          pinned: false,
          complete: true,
          createdAt: now,
          lastAccessAt: now,
          unreferencedAt: null,
        };
    await e.storage.putBlob(rec);
    await e.refs.sync(id);
    await forgetPartial(e, partial);

    const ref: BlobRef = { $blob: 1, id, size, type, space: opts.space, scope: keys.scope, keyId: keys.keyId };
    const name = opts.name ?? (source as { name?: unknown }).name;
    if (typeof name === 'string' && name) ref.name = name.slice(0, 255);
    e.status.fromRecord(rec);
    e.events.emit('blob:attached', { ref });
    return ref;
  } catch (err) {
    await e.storage.deleteChunks(partial).catch(() => undefined);
    await forgetPartial(e, partial).catch(() => undefined);
    throw err;
  }
}
