// T032: observable blob status (FR-010).
import { describe, expect, it } from 'vitest';
import { createMemoryBlobStorage, type BlobRef, type BlobStatus, type StoredBlob } from '../../src';
import { StatusHub } from '../../src/status/status';
import { pattern, testBlobs } from '../helpers';

const SPACE = 'SPACE1';
const unknownRef = (size = 1234): BlobRef => ({
  $blob: 1,
  id: 'A'.repeat(43),
  size,
  type: 'image/png',
  space: SPACE,
  scope: SPACE,
  keyId: '0123456789abcdef',
});
const record = (over: Partial<StoredBlob> = {}): StoredBlob => ({
  id: 'A'.repeat(43),
  manifest: new Uint8Array(1),
  space: SPACE,
  scope: SPACE,
  keyId: '0123456789abcdef',
  size: 1234,
  type: 'image/png',
  origin: 'remote',
  replicas: ['relay:1', 'memory:b'],
  pinned: true,
  complete: true,
  createdAt: 1,
  lastAccessAt: 1,
  unreferencedAt: null,
  ...over,
});

describe('Blobs.observe', () => {
  it('is available with no replicas for a blob attached here', async () => {
    const t = await testBlobs();
    const ref = await t.blobs.attach(new Blob([pattern(50) as BlobPart]), { space: SPACE, obj: 'o1' });
    expect(t.blobs.observe(ref).get()).toMatchObject({ state: 'available', progress: 1, bytesDone: 50, size: 50, replicas: 0, pinned: false });
  });

  it('is missing / not-requested for an unknown blob, with the size from the reference', async () => {
    const t = await testBlobs();
    expect(t.blobs.observe(unknownRef(4321)).get()).toEqual({ state: 'missing', reason: 'not-requested', size: 4321, progress: 0, bytesDone: 0, pinned: false, replicas: 0 });
  });
});

describe('StatusHub', () => {
  it('shows a blob stored by an earlier session as available once its record is read', async () => {
    const storage = createMemoryBlobStorage();
    await storage.putBlob(record());
    const hub = new StatusHub(() => storage);
    const o = hub.observe(unknownRef());
    expect(o.get().state).toBe('missing'); // synchronous answer first
    await new Promise((r) => setTimeout(r, 10));
    expect(o.get()).toMatchObject({ state: 'available', pinned: true, replicas: 2, progress: 1 });
  });

  it('shows an incomplete (evicted) record as missing / evicted', async () => {
    const storage = createMemoryBlobStorage();
    await storage.putBlob(record({ complete: false }));
    const hub = new StatusHub(() => storage);
    const o = hub.observe(unknownRef());
    await new Promise((r) => setTimeout(r, 10));
    expect(o.get()).toMatchObject({ state: 'missing', reason: 'evicted' });
  });

  it('notifies subscribers on change, stops after unsubscribe, and shares state between observers of one ID', () => {
    const hub = new StatusHub(() => createMemoryBlobStorage());
    const ref = unknownRef();
    const a = hub.observe(ref);
    const b = hub.observe(ref);
    expect(a.get()).toBe(b.get());
    const seen: BlobStatus[] = [];
    const off = a.subscribe((s) => seen.push(s));
    hub.update(ref.id, { state: 'downloading', bytesDone: 100, progress: 0.1 });
    expect(seen.map((s) => s.state)).toEqual(['downloading']);
    expect(b.get().state).toBe('downloading');
    hub.update(ref.id, { state: 'downloading', bytesDone: 100, progress: 0.1 }); // no change: no notification
    expect(seen).toHaveLength(1);
    off();
    hub.update(ref.id, { bytesDone: 200, progress: 0.2 });
    expect(seen).toHaveLength(1);
    expect(b.get().bytesDone).toBe(200);
  });

  it('drops the not-requested reason when the state moves on, and completes progress when available', () => {
    const hub = new StatusHub(() => createMemoryBlobStorage());
    const ref = unknownRef(1000);
    const o = hub.observe(ref);
    hub.update(ref.id, { state: 'downloading', bytesDone: 10, progress: 0.01 });
    expect(o.get().reason).toBeUndefined();
    hub.update(ref.id, { state: 'available' });
    expect(o.get()).toMatchObject({ state: 'available', progress: 1, bytesDone: 1000 });
  });

  it('keeps a failure reason with the failed state', () => {
    const hub = new StatusHub(() => createMemoryBlobStorage());
    const ref = unknownRef();
    const o = hub.observe(ref);
    hub.update(ref.id, { state: 'failed', reason: 'quota' });
    expect(o.get()).toMatchObject({ state: 'failed', reason: 'quota' });
  });
});
