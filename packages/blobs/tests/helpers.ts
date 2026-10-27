/** Shared test helpers: vector-backed keys, deterministic plaintext, and an engine on a plain test core. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LaneFaults, createPeers, createTestCore } from '@sync/testkit';
import { createBlobs, createMemoryBlobStorage, BlobKeyError, type Blobs, type BlobsConfig, type KeyProvider, type MemoryBlobStorage } from '../src';

const vecDir = join(__dirname, 'vectors');
export const keyVectors = JSON.parse(readFileSync(join(vecDir, 'keys.json'), 'utf8')) as Record<string, string>;
export const blobVectors = JSON.parse(readFileSync(join(vecDir, 'blobs.json'), 'utf8')) as {
  chunkBytes: number;
  cases: Array<{ name: string; size: number; manifest: string; id: string; chunks: Array<{ index: number; plainLength: number; storedLength: number; storedSha256: string }> }>;
};

export const fromHex = (h: string) => new Uint8Array(h.match(/../g)!.map((b) => parseInt(b, 16)));
export const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** The plaintext of the known-answer vectors: plain[i] = (i * 7 + 3) & 0xff. */
export const pattern = (size: number, from = 0): Uint8Array => Uint8Array.from({ length: size }, (_, i) => ((i + from) * 7 + 3) & 0xff);

async function keysOf(encHex: string, macHex: string, scopeIdHex: string, keyId: string) {
  return {
    scopeId: fromHex(scopeIdHex),
    keyId,
    enc: await crypto.subtle.importKey('raw', fromHex(encHex), 'AES-GCM', false, ['encrypt', 'decrypt']),
    mac: await crypto.subtle.importKey('raw', fromHex(macHex), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']),
  };
}

export interface VectorProvider extends KeyProvider {
  /** Make `forWrite` fail as a device without keys would. */
  denyWrites(on?: boolean): void;
  /** Hide the keys for reads (a device that was never granted the epoch); call `grant()` to let them "arrive". */
  hideReads(on?: boolean): void;
  grant(): void;
}

/**
 * Keys from the known-answer vectors. Objects whose ID starts with `share` are encrypted under the scope `SHARE1`
 * with a second, different key set; everything else under the scope equal to the Space ID.
 */
export async function vectorProvider(): Promise<VectorProvider> {
  const main = await keysOf(keyVectors.encKey!, keyVectors.macKey!, keyVectors.scopeId!, keyVectors.keyId!);
  const share = await keysOf('5a'.repeat(32), 'a5'.repeat(32), 'c0'.repeat(16), '1122334455667788');
  const listeners = new Set<(scope: string) => void>();
  let deny = false;
  let hide = false;
  const byKeyId = (scope: string, keyId: string) => (scope === 'SHARE1' && keyId === share.keyId ? share : keyId === main.keyId && scope !== 'SHARE1' ? main : undefined);
  return {
    scopeFor: (space, obj) => (obj.startsWith('share') ? 'SHARE1' : space),
    async forWrite(space, obj) {
      if (deny) throw new BlobKeyError();
      const isShare = obj.startsWith('share');
      return { scope: isShare ? 'SHARE1' : space, epoch: 1, ...(isShare ? share : main) };
    },
    async forRead(scope, keyId) {
      return hide ? undefined : byKeyId(scope, keyId);
    },
    onKeysChanged(h) {
      listeners.add(h);
      return () => void listeners.delete(h);
    },
    denyWrites: (on = true) => void (deny = on),
    hideReads: (on = true) => void (hide = on),
    grant() {
      hide = false;
      for (const l of [...listeners]) l('*');
    },
  };
}

/** A blobs engine on a plain test core with in-memory storage and the vector keys. */
export async function testBlobs(config: BlobsConfig = {}) {
  const t = await createTestCore({ resurrectingTypes: ['note'] }); // a deleted note can be undone or edited back
  const storage = createMemoryBlobStorage();
  const provider = await vectorProvider();
  const blobs: Blobs = await createBlobs({ core: t.core, keyProvider: provider, storage, config: { now: t.clock.now, ...config } });
  return { blobs, storage: storage as MemoryBlobStorage, provider, core: t.core, clock: t.clock, close: () => blobs.close() };
}

/** A Blob-like source that records every `slice` the engine asks for and builds the plaintext lazily, never as a whole. */
export function spySource(size: number, type = '', name?: string) {
  const slices: Array<[number, number]> = [];
  const source = {
    size,
    type,
    ...(name ? { name } : {}),
    slice(start = 0, end = size) {
      slices.push([start, end]);
      return new Blob([pattern(end - start, start) as BlobPart]);
    },
  } as unknown as Blob;
  return { source, slices };
}

export const SPACE = 'SPACE1';

/**
 * Plain (plaintext-codec) devices on one in-memory network, fully linked, with lane fault injection and a blobs engine each.
 * Every engine uses the same vector keys, so identical bytes attached on two devices have the same blob ID.
 */
export async function plainPeers(names: string[], config: BlobsConfig = {}, seed = 1, opts: { skip?: string[] } = {}) {
  const p = await createPeers(names, { spaces: [SPACE] });
  const faults = new LaneFaults(seed);
  for (const n of names) faults.install(p.net.transport(n, 'memory'));
  const provider = await vectorProvider();
  const storages: Record<string, MemoryBlobStorage> = {};
  const engines: Record<string, Blobs> = {};
  for (const n of names) {
    storages[n] = createMemoryBlobStorage();
    if (!opts.skip?.includes(n)) engines[n] = await createBlobs({ core: p.core(n), keyProvider: provider, storage: storages[n]!, config });
  }
  for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) p.link(names[i]!, names[j]!);
  return {
    p,
    faults,
    engines,
    storages,
    provider,
    attach: (name: string, bytes: Uint8Array, obj = 'o1') => engines[name]!.attach(new Blob([bytes as BlobPart]), { space: SPACE, obj }),
    close: async () => {
      for (const e of Object.values(engines)) await e.close();
    },
  };
}
