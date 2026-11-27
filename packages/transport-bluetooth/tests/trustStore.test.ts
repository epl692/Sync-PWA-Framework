import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { createIndexedDbTrustStore, createMemoryTrustStore, type PinnedHub, type TrustedHubStore } from '../src/trustStore';

const hub = (over: Partial<PinnedHub> = {}): PinnedHub => ({ fingerprint: 'fp1', name: 'Camp hub', autoReconnect: true, publicKey: new Uint8Array(32).fill(7), lastConnected: 5, browserDeviceId: 'dev-1', ...over });

function suite(name: string, make: () => TrustedHubStore) {
  describe(name, () => {
    it('starts empty, stores and returns a pinned Hub with its key', async () => {
      const s = make();
      expect(await s.list()).toEqual([]);
      expect(await s.get('fp1')).toBeUndefined();
      await s.put(hub());
      const got = (await s.get('fp1'))!;
      expect(got.name).toBe('Camp hub');
      expect(Array.from(got.publicKey)).toEqual(Array.from(new Uint8Array(32).fill(7)));
      expect(got.browserDeviceId).toBe('dev-1');
    });
    it('list never exposes keys, put replaces, forget removes', async () => {
      const s = make();
      await s.put(hub());
      await s.put(hub({ name: 'Renamed', autoReconnect: false }));
      const l = await s.list();
      expect(l).toHaveLength(1);
      expect(l[0]).toEqual({ fingerprint: 'fp1', name: 'Renamed', autoReconnect: false, lastConnected: 5 });
      expect('publicKey' in l[0]!).toBe(false);
      await s.forget('fp1');
      expect(await s.list()).toEqual([]);
      await s.forget('nope'); // no error
    });
    it('keeps several Hubs apart', async () => {
      const s = make();
      await s.put(hub());
      await s.put(hub({ fingerprint: 'fp2', name: 'Other' }));
      expect((await s.list()).map((h) => h.fingerprint).sort()).toEqual(['fp1', 'fp2']);
    });
  });
}

suite('memory trust store', createMemoryTrustStore);
suite('IndexedDB trust store (fake-indexeddb)', () => createIndexedDbTrustStore(new IDBFactory()));

describe('IndexedDB trust store degrades instead of failing', () => {
  it('with no IndexedDB, list is empty and put/get/forget do not throw', async () => {
    const s = createIndexedDbTrustStore(undefined);
    expect(await s.list()).toEqual([]);
    expect(await s.get('x')).toBeUndefined();
    await expect(s.put(hub())).resolves.toBeUndefined();
    await expect(s.forget('x')).resolves.toBeUndefined();
  });
  it('survives a database that refuses to open', async () => {
    const broken = { open: () => { const r: any = {}; setTimeout(() => r.onerror?.(), 0); return r; } } as unknown as IDBFactory;
    const s = createIndexedDbTrustStore(broken);
    expect(await s.list()).toEqual([]);
  });
  it('pins persist across store instances on the same database', async () => {
    const idb = new IDBFactory();
    await createIndexedDbTrustStore(idb).put(hub());
    expect((await createIndexedDbTrustStore(idb).list()).map((h) => h.fingerprint)).toEqual(['fp1']);
  });
});
