// T090: what an Identity Provider cannot do with the device it is handed.
import { describe, expect, it } from 'vitest';
import { createSecureNode } from '@sync/testkit';
import type { IdentityProvider, LocalDevice, ProviderHost } from '../../src';
import { createStubIdentityProvider } from '@sync/testkit';

describe('the device handed to a provider', () => {
  it('signs device bindings but refuses to sign anything else (so it cannot forge packets)', async () => {
    let device!: LocalDevice;
    const base = createStubIdentityProvider();
    const provider = (): IdentityProvider => ({
      ...base,
      init: async (h: ProviderHost) => {
        device = h.device();
        return base.init(h);
      },
    });
    await createSecureNode({ provider });
    const tag = new TextEncoder().encode('sync-binding/genesis/1|');
    expect((await device.sign(new Uint8Array([...tag, 1, 2, 3]))).byteLength).toBe(64);
    await expect(device.sign(new TextEncoder().encode('{"v":1,"id":"x:1"}'))).rejects.toThrow(
      /only sign device bindings/,
    );
    await expect(device.sign(new Uint8Array())).rejects.toThrow();
    // it can agree on a secret with a peer key, but exposes no private key
    expect(Object.keys(device).sort()).toEqual([
      'agreePub',
      'deriveShared',
      'deviceId',
      'name',
      'sign',
      'signPub',
    ]);
  });
});
