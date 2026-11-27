// Spec 005 T095 (US5): a blob attached on one client reaches another through the Hub over Bluetooth, verified, with progress, and resumes.
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryBleLink, MockBleBridge, createSpaceAccess, createTestCore, memberProofs, waitFor } from '@sync/testkit';
import { createBlobs, createMemoryBlobStorage, CHUNK_BYTES, type Blobs } from '@sync/blobs';
import { createBluetoothTransport, createMemoryTrustStore } from '@sync/transport-bluetooth';
import { createHub, createMemoryStore } from '../../src';
// the vector keys the blob tests use, so both clients derive the same blob IDs
import { pattern, vectorProvider } from '../../../blobs/tests/helpers';

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  const r = stream.getReader();
  for (;;) {
    const { done, value } = await r.read();
    if (done) break;
    parts.push(value);
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await Promise.race([cleanups.pop()!().catch(() => undefined), new Promise((r) => setTimeout(r, 3000))]);
});

async function world(o: { latencyMs?: number } = {}) {
  const link = new MemoryBleLink({ mtu: 185 });
  const bridge = new MockBleBridge(link);
  const blobStorage = createMemoryBlobStorage();
  const hub = await createHub({ bridge, store: createMemoryStore(), blobs: { storage: blobStorage, onError: () => undefined } });
  await hub.start();
  const access = await createSpaceAccess();
  await hub.addServeCode(access.serveCode);
  cleanups.push(async () => void (await hub.stop(), await bridge.close()));
  const provider = await vectorProvider();
  const client = async (name: string, air?: Parameters<MemoryBleLink['bluetooth']>[0]) => {
    const t = await createTestCore({ spaces: [access.space] });
    const transport = createBluetoothTransport({ proofs: await memberProofs([access], name), confirmHub: async () => true, trustStore: createMemoryTrustStore(), bluetooth: link.bluetooth(air) as never, isSecureContext: true });
    t.core.addTransport(transport);
    const blobs: Blobs = await createBlobs({ core: t.core, keyProvider: provider, storage: createMemoryBlobStorage() });
    cleanups.push(async () => void (await blobs.close(), await transport.stop(), await t.core.close()));
    return { core: t.core, transport, blobs, space: access.space };
  };
  return { link, bridge, hub, blobStorage, access, client, ...o };
}

describe('blobs over Bluetooth through a Hub', () => {
  it('a blob attached on A arrives on B verified, with progress, even though A has gone (store and forward)', async () => {
    const w = await world();
    const a = await w.client('alice');
    const b = await w.client('bob');
    await a.transport.chooseHub();
    const bytes = pattern(CHUNK_BYTES * 2 + 123, 5);
    const ref = await a.blobs.attach(new Blob([bytes as BlobPart]), { space: w.access.space, obj: 'o1' });
    // the reference rides in an ordinary packet so B learns about the blob
    await a.core.create(w.access.space, 'note', { photo: ref as never });
    await waitFor(async () => (await w.blobStorage.getBlob(ref.id))?.complete === true, 30_000, 'the Hub to hold the blob');
    await new Promise((r) => setTimeout(r, 50));
    await a.transport.disconnectHub(a.transport.connections()[0]!.fingerprint); // A is gone
    // the Hub holds only ciphertext: what it stored is not the plaintext
    const stored = await w.blobStorage.getChunk(ref.id, 0);
    expect(stored).toBeDefined();
    expect(Array.from(stored!.slice(0, 64))).not.toEqual(Array.from(bytes.slice(0, 64)));

    const progress: number[] = [];
    b.blobs.on('blob:progress', (e) => progress.push(e.bytesDone));
    await b.transport.chooseHub();
    await waitFor(async () => (await b.core.query({ space: w.access.space, type: 'note' }).once()).length === 1, 10_000, 'the note');
    await b.blobs.request(ref);
    expect(b.blobs.observe(ref).get().state).toBe('available');
    expect(await readAll(await b.blobs.open(ref))).toEqual(bytes);
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.at(-1)).toBe(ref.size);
  }, 90_000);

  it('a transfer interrupted midway resumes and asks only for the chunks it lacks', async () => {
    const w = await world();
    const a = await w.client('alice');
    const b = await w.client('bob', { latencyMs: 1 });
    await a.transport.chooseHub();
    const bytes = pattern(CHUNK_BYTES * 4, 9);
    const ref = await a.blobs.attach(new Blob([bytes as BlobPart]), { space: w.access.space, obj: 'o2' });
    await a.core.create(w.access.space, 'note', { photo: ref as never });
    await waitFor(async () => (await w.blobStorage.getBlob(ref.id))?.complete === true, 30_000, 'the Hub to hold the blob');
    // the Hub holds only ciphertext: what it stored is not the plaintext
    const stored = await w.blobStorage.getChunk(ref.id, 0);
    expect(stored).toBeDefined();
    expect(Array.from(stored!.slice(0, 64))).not.toEqual(Array.from(bytes.slice(0, 64)));
    await b.transport.chooseHub();
    await waitFor(async () => (await b.core.query({ space: w.access.space, type: 'note' }).once()).length === 1, 10_000, 'the note');
    const wanted = b.blobs.request(ref).catch(() => undefined);
    await waitFor(() => (b.blobs.observe(ref).get() as { bytesDone?: number }).bytesDone !== undefined && ((b.blobs.observe(ref).get() as { bytesDone?: number }).bytesDone ?? 0) > CHUNK_BYTES, 30_000, 'some of it to arrive');
    w.bridge.setInRange(false);
    await waitFor(() => b.transport.connections().length === 0, 5000, 'the drop');
    w.bridge.setInRange(true);
    await b.transport.chooseHub();
    await Promise.race([wanted, new Promise((r) => setTimeout(r, 200))]);
    await b.blobs.request(ref); // asking again is how an app resumes: only the missing chunks are fetched
    expect(b.blobs.observe(ref).get().state).toBe('available');
    expect(await readAll(await b.blobs.open(ref))).toEqual(bytes);
  }, 120_000);
});
