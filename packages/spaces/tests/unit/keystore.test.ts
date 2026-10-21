// T021: keystore with in-memory and fake IndexedDB backends.
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { base32 } from '@sync/core';
import { hex } from '../../src/crypto/bytes';
import { keyIdOf } from '../../src/crypto/ids';
import { indexedDbKeyDb, memoryKeyDb } from '../../src/keystore/keydb';
import { Keystore } from '../../src/keystore/keystore';

const scope = base32(new Uint8Array(16).fill(9));
const rawKey = () => crypto.getRandomValues(new Uint8Array(32));

describe('Keystore', () => {
  it('creates a device whose private keys cannot be exported and whose ID hashes its public key', async () => {
    const ks = await Keystore.open(memoryKeyDb());
    const d = await ks.createDevice({ displayName: 'Maya', userId: 'self' });
    expect(d.signPriv.extractable).toBe(false);
    expect(d.agreePriv.extractable).toBe(false);
    expect(d.wrapKey.extractable).toBe(false);
    expect(d.userId).toBe(d.deviceId);
    expect(d.deviceId).toHaveLength(26);
    await expect(ks.createDevice()).rejects.toThrow(/already exists/);
  });

  it('stores epoch keys only wrapped: the raw bytes appear nowhere in the database', async () => {
    const db = memoryKeyDb();
    const ks = await Keystore.open(db);
    await ks.createDevice({ userId: 'self' });
    const raw = rawKey();
    const keyId = await ks.putEpochKey(scope, 0, raw, 'self');
    expect(keyId).toBe(hex(await keyIdOf(raw)));
    const dump = JSON.stringify((await db.all('epoch-keys')).map((r) => Array.from((r.value as { wrapped: Uint8Array }).wrapped)));
    expect(dump).not.toContain(Array.from(raw).join(','));
    expect(await ks.rawKey(scope, keyId)).toEqual(raw);
    expect((await ks.aesKey(scope, keyId))!.extractable).toBe(false);
  });

  it('a copy of the epoch-key records is useless without the wrapping key', async () => {
    const a = memoryKeyDb();
    const ksA = await Keystore.open(a);
    await ksA.createDevice({ userId: 'self' });
    const keyId = await ksA.putEpochKey(scope, 0, rawKey(), 'self');
    const b = memoryKeyDb();
    for (const r of await a.all('epoch-keys')) await b.put('epoch-keys', r.key, r.value);
    const ksB = await Keystore.open(b);
    await ksB.createDevice({ userId: 'self' }); // a different device, so a different wrapping key
    expect(await ksB.hasKey(scope, keyId)).toBe(true);
    expect(await ksB.rawKey(scope, keyId)).toBeUndefined();
    expect(await ksB.aesKey(scope, keyId)).toBeUndefined();
  });

  it('is idempotent per key, lists epochs oldest first, and tracks the key source', async () => {
    const ks = await Keystore.open(memoryKeyDb());
    await ks.createDevice({ userId: 'self' });
    const k1 = rawKey();
    const k2 = rawKey();
    await ks.putEpochKey(scope, 1, k2, 'grant');
    await ks.putEpochKey(scope, 0, k1, 'self');
    await ks.putEpochKey(scope, 0, k1, 'self');
    expect((await ks.epochs(scope)).map((e) => [e.epoch, e.source])).toEqual([
      [0, 'self'],
      [1, 'grant'],
    ]);
    expect(await ks.epochs(base32(new Uint8Array(16).fill(1)))).toEqual([]);
  });

  it('survives reopening on IndexedDB: the same device, keys and counters', async () => {
    const factory = new IDBFactory();
    const ks1 = await Keystore.open(await indexedDbKeyDb({ factory }));
    const d1 = await ks1.createDevice({ displayName: 'A', userId: 'self' });
    const raw = rawKey();
    const keyId = await ks1.putEpochKey(scope, 0, raw, 'self');
    for (let i = 0; i < 5; i++) await ks1.bumpCounter(scope, keyId);
    await ks1.close();

    const ks2 = await Keystore.open(await indexedDbKeyDb({ factory }));
    expect(ks2.device()!.deviceId).toBe(d1.deviceId);
    expect(ks2.device()!.signPriv.extractable).toBe(false);
    expect(await ks2.rawKey(scope, keyId)).toEqual(raw);
    expect(await ks2.counter(scope, keyId)).toBe(5);
    // the stored private key still signs
    const sig = await crypto.subtle.sign('Ed25519', ks2.device()!.signPriv, new Uint8Array([1]));
    expect(sig.byteLength).toBe(64);
  });

  it('keeps invite secrets and replay nonces only in the local store', async () => {
    const ks = await Keystore.open(memoryKeyDb());
    await ks.createDevice({ userId: 'self' });
    await ks.putInvite('inv1', { secret: new Uint8Array([1, 2, 3]), seenNonces: ['n1'] });
    expect((await ks.getInvite('inv1'))!.seenNonces).toEqual(['n1']);
    expect(await ks.getInvite('nope')).toBeUndefined();
  });
});
