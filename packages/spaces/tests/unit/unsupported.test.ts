// T042: where Ed25519 or X25519 is missing, nothing is created and nothing falls back to plaintext.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryStorage } from '@sync/core';
import { createStubIdentityProvider } from '@sync/testkit';
import { UnsupportedError, memoryKeyDb, openSecureCore } from '../../src';

afterEach(() => vi.restoreAllMocks());

describe('unsupported environments', () => {
  it('reports unsupported, creates no Space, and the core cannot write in plaintext', async () => {
    const real = globalThis.crypto.subtle.generateKey.bind(globalThis.crypto.subtle);
    vi.spyOn(globalThis.crypto.subtle, 'generateKey').mockImplementation(((alg: { name?: string } | string, ...rest: unknown[]) => {
      const name = typeof alg === 'string' ? alg : alg.name;
      if (name === 'Ed25519') return Promise.reject(new Error('NotSupportedError'));
      return (real as (...a: unknown[]) => unknown)(alg, ...rest);
    }) as never);

    const { core, spaces } = await openSecureCore({ keyDb: memoryKeyDb(), provider: createStubIdentityProvider(), core: { storage: createMemoryStorage(), autoCompact: false } });
    expect(spaces.state).toBe('unsupported');
    await expect(spaces.create('x')).rejects.toBeInstanceOf(UnsupportedError);
    await expect(spaces.signUp()).rejects.toBeInstanceOf(UnsupportedError);
    expect(await spaces.list()).toEqual([]);
    expect(core.codecs().ids).toEqual([]);
    await expect(core.create('s', 'item', { a: 1 })).rejects.toThrow(/codec/i);
    await core.close();
  });

  it('a supported environment registers only the encrypting codec', async () => {
    const { core, spaces } = await openSecureCore({ keyDb: memoryKeyDb(), provider: createStubIdentityProvider(), core: { storage: createMemoryStorage(), autoCompact: false } });
    expect(spaces.state).toBe('ready');
    expect(core.codecs()).toEqual({ default: 'aes-gcm-space/1', ids: ['aes-gcm-space/1'] });
    await spaces.close();
    await core.close();
  });
});
