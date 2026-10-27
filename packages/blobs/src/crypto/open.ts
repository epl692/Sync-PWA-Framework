/** Opening a blob: decrypt chunk by chunk into a stream, verifying every tag. Never holds more than a chunk or two. */

import type { Engine } from '../engine';
import { decodeManifest } from '../format/manifest';
import type { BlobRef } from '../format/ref';
import { BlobFetchError, BlobIntegrityError, BlobNotLocalError, type OpenOptions } from '../types';
import { openChunk } from './chunk';

export async function openBlob(e: Engine, ref: BlobRef, opts: OpenOptions = {}): Promise<ReadableStream<Uint8Array>> {
  opts.signal?.throwIfAborted();
  let rec = await e.storage.getBlob(ref.id);
  if (!rec?.complete) {
    if (opts.fetch === false) throw new BlobNotLocalError();
    await e.scheduler.request(ref, { priority: 'high', signal: opts.signal });
    rec = await e.storage.getBlob(ref.id);
    if (!rec?.complete) throw new BlobFetchError('unavailable');
  }
  const keys = await e.keys.forRead(rec.scope, rec.keyId);
  if (!keys) {
    e.scheduler.noteNoKey(rec);
    throw new BlobFetchError('no-key');
  }
  const m = decodeManifest(rec.manifest, { maxBlobBytes: e.cfg.maxBlobBytes });
  if (!m.ok) throw new BlobIntegrityError(`stored manifest is invalid: ${m.reason}`);
  const { size } = m.manifest;
  const n = m.manifest.digests.length;
  const id = rec.id;

  // the lease keeps eviction away while a stream is open; touching the record keeps it recently used
  e.leases.set(id, (e.leases.get(id) ?? 0) + 1);
  await e.storage.putBlob({ ...rec, lastAccessAt: e.now(), unreferencedAt: null });
  let i = 0;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const left = (e.leases.get(id) ?? 1) - 1;
    if (left <= 0) e.leases.delete(id);
    else e.leases.set(id, left);
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        opts.signal?.throwIfAborted();
        if (i >= n) {
          controller.close();
          return release();
        }
        const stored = await e.storage.getChunk(id, i);
        if (!stored) throw new BlobIntegrityError(`chunk ${i} is missing from storage`);
        controller.enqueue(await openChunk(keys, size, i, stored));
        i++;
      } catch (err) {
        release();
        controller.error(err);
      }
    },
    cancel: release,
  });
}

export async function toBlob(e: Engine, ref: BlobRef, opts: OpenOptions = {}): Promise<Blob> {
  const stream = await openBlob(e, ref, opts);
  const parts: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  return new Blob(parts as BlobPart[], { type: ref.type });
}
