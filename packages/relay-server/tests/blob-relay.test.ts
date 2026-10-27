// T056 (spec 004 R-1, US2.4): the relay stores and serves ciphertext blobs, verifies structure only, and is a cache.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HubNetwork, createTestCore, waitFor } from '@sync/testkit';
import {
  CHUNK_BYTES,
  createBlobs,
  createMemoryBlobStorage,
  decodeLaneMessage,
  encodeLaneMessage,
  type BlobRef,
  type Blobs,
  type KeyProvider,
  type LaneMsg,
  type MemoryBlobStorage,
} from '@sync/blobs';
import { BlobRelay, createFileBlobStorage, type BlobRelayOptions } from '../src';

const SPACE = 'SPACE1';
const DAY = 24 * 60 * 60 * 1000;
const pattern = (size: number, from = 0) => Uint8Array.from({ length: size }, (_, i) => ((i + from) * 7 + 3) & 0xff);
const bytesOf = async (b: Blob) => new Uint8Array(await b.arrayBuffer());

/** One fixed key set for every client, so identical bytes make identical blobs. */
async function provider(): Promise<KeyProvider> {
  const enc = await crypto.subtle.importKey('raw', new Uint8Array(32).fill(1), 'AES-GCM', false, ['encrypt', 'decrypt']);
  const mac = await crypto.subtle.importKey('raw', new Uint8Array(32).fill(2), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const keys = { scopeId: new Uint8Array(16).fill(9), keyId: '00112233445566aa', enc, mac };
  return {
    scopeFor: (space) => space,
    forWrite: async (space) => ({ scope: space, epoch: 1, ...keys }),
    forRead: async () => keys,
    onKeysChanged: () => () => undefined,
  };
}

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});
const tmp = async () => {
  const d = await mkdtemp(join(tmpdir(), 'blob-relay-'));
  dirs.push(d);
  return d;
};

async function rig(opts: Partial<BlobRelayOptions> = {}, existing?: { storage: ReturnType<typeof createMemoryBlobStorage> | Awaited<ReturnType<typeof createFileBlobStorage>> }) {
  const net = new HubNetwork();
  const storage = existing?.storage ?? createMemoryBlobStorage();
  let clock = 1_000_000;
  const relay = new BlobRelay(net.hub, { storage, now: () => clock, onError: () => undefined, ...opts }); // late work after a test removed its directory is noise
  const keys = await provider();
  const engines: Blobs[] = [];
  const stores: Record<string, MemoryBlobStorage> = {};
  const transports: Record<string, ReturnType<HubNetwork['transport']>> = {};
  async function client(name: string) {
    const t = await createTestCore({ spaces: [SPACE] });
    transports[name] = net.transport(name);
    t.core.addTransport(transports[name]!);
    stores[name] = createMemoryBlobStorage();
    const blobs = await createBlobs({ core: t.core, keyProvider: keys, storage: stores[name]!, config: { requestTimeoutMs: 300 } });
    engines.push(blobs);
    await waitFor(() => t.core.peers().some((p) => p.lanes.length && p.spaces.includes('*')), 5000, 'the relay as a lane peer');
    return { blobs, core: t.core, store: stores[name]!, attach: (bytes: Uint8Array, obj = 'o1') => blobs.attach(new Blob([bytes as BlobPart]), { space: SPACE, obj }) };
  }
  /** A client that speaks the lane by hand, for hostile or malformed behaviour. */
  async function rawClient(name: string, spaces: string[] = [SPACE]) {
    const t = await createTestCore({ spaces });
    t.core.addTransport(net.transport(name));
    const lane = t.core.lane(0xb1);
    const got: LaneMsg[] = [];
    lane.onMessage((_k, b) => {
      const d = decodeLaneMessage(b);
      if (d.ok && 'msg' in d) got.push(d.msg);
    });
    await waitFor(() => lane.peers().length === 1, 5000, 'relay lane peer');
    const to = (m: LaneMsg) => lane.send(lane.peers()[0]!.key, encodeLaneMessage(m));
    await to({ type: 'hello', v: 1, window: 8, maxChunks: 4096, serve: true });
    return { got, to };
  }
  return { net, storage, relay, client, rawClient, advance: (ms: number) => (clock += ms), transports, stores, close: async () => { for (const e of engines) await e.close(); relay.close(); } };
}

const complete = async (storage: { getBlob(id: string): Promise<{ complete?: boolean } | undefined> }, id: string) => (await storage.getBlob(id))?.complete === true;

describe('storing and serving', () => {
  it('pulls a blob a client offers, verifies it, confirms with `stored`, and serves it to another client', async () => {
    const r = await rig();
    const a = await r.client('a');
    const b = await r.client('b');
    const bytes = pattern(CHUNK_BYTES * 3 + 5);
    const ref = await a.attach(bytes);
    await waitFor(() => complete(r.storage, ref.id), 10_000, 'relay stored it');
    await waitFor(() => a.blobs.observe(ref).get().replicas === 1, 5000, 'the client records the relay as a replica');
    await b.blobs.request(ref);
    expect((await bytesOf(await b.blobs.toBlob(ref))).every((v, i) => v === bytes[i])).toBe(true);
    await r.close();
  }, 60_000);

  it('answers `stored` at once for a blob it already holds, and serves partial ranges with `miss` for the rest', async () => {
    const r = await rig();
    const a = await r.client('a');
    const ref = await a.attach(pattern(CHUNK_BYTES * 2));
    await waitFor(() => complete(r.storage, ref.id), 10_000, 'stored');
    const raw = await r.rawClient('raw');
    await raw.to({ type: 'offer', space: SPACE, id: ref.id, size: ref.size });
    await waitFor(() => raw.got.some((m) => m.type === 'stored' && m.id === ref.id), 5000, 'stored answer');
    await raw.to({ type: 'get', id: ref.id, manifest: false, space: SPACE, ranges: [[0, 5]] });
    await waitFor(() => raw.got.some((m) => m.type === 'miss'), 5000, 'miss');
    expect(raw.got.filter((m) => m.type === 'chunk')).toHaveLength(2);
    const miss = raw.got.find((m) => m.type === 'miss') as Extract<LaneMsg, { type: 'miss' }>;
    expect(miss.ranges).toEqual([[2, 5]]);
    await r.close();
  }, 60_000);
});

describe('verification (no keys)', () => {
  it('rejects a manifest that does not hash to the offered ID, and stores nothing', async () => {
    const r = await rig();
    const raw = await r.rawClient('raw');
    const id = 'E'.repeat(43);
    await raw.to({ type: 'offer', space: SPACE, id, size: 1000 });
    await waitFor(() => raw.got.some((m) => m.type === 'get'), 5000, 'the relay pulls');
    await raw.to({ type: 'manifest', id, manifest: new Uint8Array(73).fill(1) });
    await waitFor(() => raw.got.some((m) => m.type === 'reject'), 5000, 'reject');
    expect(await r.storage.getBlob(id)).toBeUndefined();
    await r.close();
  }, 60_000);

  it('rejects a chunk that fails its digest and keeps the blob incomplete', async () => {
    const r = await rig();
    const a = await r.client('a');
    const ref = await a.attach(pattern(CHUNK_BYTES * 2));
    await waitFor(() => complete(r.storage, ref.id), 10_000, 'stored');
    // an impostor offers the same blob but sends a corrupted chunk: use a second relay that has never seen it
    const r2 = await rig();
    const raw = await r2.rawClient('raw');
    const rec = (await a.store.getBlob(ref.id))!;
    const chunk = (await a.store.getChunk(ref.id, 0))!.slice();
    chunk[40]! ^= 1;
    await raw.to({ type: 'offer', space: SPACE, id: ref.id, size: ref.size });
    await waitFor(() => raw.got.some((m) => m.type === 'get'), 5000, 'pull');
    await raw.to({ type: 'manifest', id: ref.id, manifest: rec.manifest });
    await waitFor(async () => (await r2.storage.getBlob(ref.id)) !== undefined, 5000, 'manifest stored');
    await raw.to({ type: 'chunk', id: ref.id, index: 0, stored: chunk });
    await waitFor(() => raw.got.some((m) => m.type === 'reject'), 5000, 'reject');
    expect(await r2.storage.presentChunks(ref.id)).toEqual([]);
    expect(await complete(r2.storage, ref.id)).toBe(false);
    await r.close();
    await r2.close();
  }, 60_000);

  it('refuses an offer for a Space the peer never declared', async () => {
    const r = await rig();
    const raw = await r.rawClient('raw', ['OTHER']);
    await raw.to({ type: 'offer', space: SPACE, id: 'I'.repeat(43), size: 10 });
    await waitFor(() => raw.got.some((m) => m.type === 'reject' && m.reason === 'space'), 5000, 'reject space');
    await r.close();
  }, 60_000);

  it('lets a configured authorize hook refuse a peer', async () => {
    const r = await rig({ authorize: (_s, peer) => peer !== 'raw' });
    const raw = await r.rawClient('raw');
    await raw.to({ type: 'offer', space: SPACE, id: 'M'.repeat(43), size: 10 });
    await waitFor(() => raw.got.some((m) => m.type === 'reject' && m.reason === 'space'), 5000, 'refused');
    await r.close();
  }, 60_000);
});

describe('caps and retention (the relay is a cache)', () => {
  it('rejects a blob over maxBlobBytes as too-large', async () => {
    const r = await rig({ maxBlobBytes: 1000 });
    const raw = await r.rawClient('raw');
    await raw.to({ type: 'offer', space: SPACE, id: 'U'.repeat(43), size: 5000 });
    await waitFor(() => raw.got.some((m) => m.type === 'reject' && m.reason === 'too-large'), 5000, 'too-large');
    await r.close();
  }, 60_000);

  it('rejects with `quota` a blob that cannot fit even after evicting everything', async () => {
    const r = await rig({ totalBytes: 100 });
    const raw = await r.rawClient('raw');
    await raw.to({ type: 'offer', space: SPACE, id: 'Q'.repeat(43), size: 5000 });
    await waitFor(() => raw.got.some((m) => m.type === 'reject' && m.reason === 'quota'), 5000, 'quota');
    await r.close();
  }, 60_000);

  it('evicts the least recently used blob first when a cap is reached', async () => {
    const size = CHUNK_BYTES;
    const r = await rig({ totalBytes: size * 2 });
    const a = await r.client('a');
    const first = await a.attach(pattern(size, 1), 'o1');
    await waitFor(() => complete(r.storage, first.id), 10_000, 'first stored');
    r.advance(1000);
    const second = await a.attach(pattern(size, 2), 'o2');
    await waitFor(() => complete(r.storage, second.id), 10_000, 'second stored');
    r.advance(1000);
    const third = await a.attach(pattern(size, 3), 'o3');
    await waitFor(() => complete(r.storage, third.id), 10_000, 'third stored');
    expect(await r.storage.getBlob(first.id)).toBeUndefined(); // the oldest went
    expect(await complete(r.storage, second.id)).toBe(true);
    await r.close();
  }, 60_000);

  it('deletes blobs idle for longer than the TTL (default 90 days) and keeps ones that were used', async () => {
    const r = await rig({ ttlMs: 10 * DAY });
    const a = await r.client('a');
    const old = await a.attach(pattern(1000, 1), 'o1');
    const used = await a.attach(pattern(1000, 2), 'o2');
    await waitFor(() => complete(r.storage, old.id).then(async (x) => x && (await complete(r.storage, used.id))), 10_000, 'both stored');
    r.advance(8 * DAY);
    const b = await r.client('b');
    await b.blobs.request(used); // a download counts as use
    r.advance(8 * DAY);
    expect(await r.relay.sweep()).toBe(1);
    expect(await r.storage.getBlob(old.id)).toBeUndefined();
    expect(await complete(r.storage, used.id)).toBe(true);
    await r.close();
  }, 60_000);

  it('is repopulated by a client that still holds a blob the relay lost, when it reconnects', async () => {
    const r = await rig();
    const a = await r.client('a');
    const ref = await a.attach(pattern(CHUNK_BYTES + 1));
    await waitFor(() => complete(r.storage, ref.id), 10_000, 'stored');
    await waitFor(() => a.blobs.observe(ref).get().replicas === 1, 5000, 'replica recorded');
    await r.storage.deleteBlob(ref.id); // the relay forgets
    r.transports.a!.setOnline(false);
    await new Promise((res) => setTimeout(res, 50));
    r.transports.a!.setOnline(true);
    await waitFor(() => complete(r.storage, ref.id), 10_000, 'stored again');
    await r.close();
  }, 60_000);
});

describe('on disk', () => {
  it('survives a restart: a new relay on the same directory serves what the old one stored', async () => {
    const dir = await tmp();
    const bytes = pattern(CHUNK_BYTES * 2 + 17, 4);
    let ref: BlobRef;
    {
      const r = await rig({}, { storage: await createFileBlobStorage(dir) });
      const a = await r.client('a');
      ref = await a.attach(bytes);
      await waitFor(() => complete(r.storage, ref.id), 10_000, 'stored on disk');
      await r.close();
    }
    const r2 = await rig({}, { storage: await createFileBlobStorage(dir) });
    const b = await r2.client('b');
    await b.blobs.request(ref);
    expect((await bytesOf(await b.blobs.toBlob(ref))).every((v, i) => v === bytes[i])).toBe(true);
    await r2.close();
  }, 60_000);
});
