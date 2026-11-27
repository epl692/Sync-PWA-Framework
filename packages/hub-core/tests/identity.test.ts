import { describe, expect, it } from 'vitest';
import { fingerprintBytes } from '@sync/transport-bluetooth/link';
import { loadOrCreateHubIdentity } from '../src/identity';
import { createMemoryStore } from '../src/store/memoryStore';

describe('Hub identity', () => {
  it('is created on first run and is the same after a restart', async () => {
    const store = createMemoryStore();
    const a = await loadOrCreateHubIdentity(store);
    expect(a.publicKey).toHaveLength(32);
    expect(a.fingerprintText).toMatch(/^([a-z2-7]{4}-){7}[a-z2-7]{4}$/);
    expect(a.words).toHaveLength(4);
    const b = await loadOrCreateHubIdentity(store);
    expect(Array.from(b.publicKey)).toEqual(Array.from(a.publicKey));
    expect(b.fingerprintText).toBe(a.fingerprintText);
  });

  it('fingerprint is SHA-256 of the public key, and differs per Hub', async () => {
    const a = await loadOrCreateHubIdentity(createMemoryStore());
    const b = await loadOrCreateHubIdentity(createMemoryStore());
    expect(Array.from(a.fingerprint)).toEqual(Array.from(await fingerprintBytes(a.publicKey)));
    expect(a.fingerprintText).not.toBe(b.fingerprintText);
  });

  it('signs messages that verify under the public key', async () => {
    const id = await loadOrCreateHubIdentity(createMemoryStore());
    const msg = new TextEncoder().encode('hello');
    const sig = await id.sign(msg);
    const key = await crypto.subtle.importKey('raw', id.publicKey as unknown as BufferSource, { name: 'Ed25519' }, false, ['verify']);
    expect(await crypto.subtle.verify({ name: 'Ed25519' }, key, sig as unknown as BufferSource, msg as unknown as BufferSource)).toBe(true);
  });

  it('a stored seed of the wrong length is replaced, not trusted', async () => {
    const store = createMemoryStore();
    await store.saveHubKey(new Uint8Array(5));
    const id = await loadOrCreateHubIdentity(store);
    expect(id.publicKey).toHaveLength(32);
    expect(await store.loadHubKey()).toHaveLength(32);
  });
});
