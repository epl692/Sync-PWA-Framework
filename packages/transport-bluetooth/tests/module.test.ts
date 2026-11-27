import { describe, expect, it } from 'vitest';
import { bluetoothModule, BLUETOOTH_MODULE_ID, BLUETOOTH_TRANSPORT_ID } from '../src/module';
import { createMemoryTrustStore } from '../src/index';

const options = { proofs: undefined as never, confirmHub: async () => false, trustStore: createMemoryTrustStore() };

describe('bluetooth module', () => {
  it('is an ordinary module with one transport and no object types', () => {
    const m = bluetoothModule({ options });
    expect(m.id).toBe(BLUETOOTH_MODULE_ID);
    expect(m.id).toMatch(/^[a-z][a-z0-9]{1,23}$/);
    expect(m.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(m.provides?.types ?? []).toEqual([]);
    expect(m.provides?.transports?.map((t) => t.id)).toEqual([BLUETOOTH_TRANSPORT_ID]);
    expect(m.access?.types).toEqual({ read: [], write: [] });
  });

  it('creates the Bluetooth transport', async () => {
    const t = await bluetoothModule({ options }).provides!.transports![0]!.create({} as never);
    expect(t.id).toBe('bluetooth');
    expect(t.supported().ok).toBe(false); // no Web Bluetooth in Node: reported, not thrown
  });
});
