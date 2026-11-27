// Spec 005 US3: when the radio drops frames the link notices, both sides restart the sync handshake, and the clients still converge.
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryBleLink, MockBleBridge, createSpaceAccess, createTestCore, memberProofs, waitFor } from '@sync/testkit';
import { createBluetoothTransport, createMemoryTrustStore } from '@sync/transport-bluetooth';
import { createHub, createMemoryStore } from '../../src';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!().catch(() => undefined);
});

describe('loss and duplication on the radio', () => {
  it('a noisy stretch loses frames; once it clears, both clients converge with nothing lost', async () => {
    const link = new MemoryBleLink({ mtu: 185, seed: 11 });
    const bridge = new MockBleBridge(link);
    const hub = await createHub({ bridge, store: createMemoryStore() });
    await hub.start();
    const access = await createSpaceAccess();
    await hub.addServeCode(access.serveCode);
    cleanups.push(async () => void (await hub.stop(), await bridge.close()));

    const make = async (name: string) => {
      const t = await createTestCore({ spaces: [access.space] });
      const transport = createBluetoothTransport({ proofs: await memberProofs([access], name), confirmHub: async () => true, trustStore: createMemoryTrustStore(), bluetooth: link.bluetooth() as never, isSecureContext: true });
      t.core.addTransport(transport);
      cleanups.push(async () => void (await transport.stop(), await t.core.close()));
      return { core: t.core, transport };
    };
    const a = await make('alice');
    const b = await make('bob');
    await a.transport.chooseHub();
    await b.transport.chooseHub();

    link.setFaults({ lossRate: 0.02, duplicateRate: 0.1 }); // a noisy stretch
    for (let i = 0; i < 60; i++) {
      await a.core.create(access.space, 'note', { from: 'a', i, pad: 'x'.repeat(200) });
      if (i % 3 === 0) await b.core.create(access.space, 'note', { from: 'b', i });
    }
    await new Promise((r) => setTimeout(r, 300));
    link.setFaults({ lossRate: 0, duplicateRate: 0 }); // it clears

    // a clean write after the noise gives any stalled sync something to carry
    await a.core.create(access.space, 'note', { from: 'a', done: true });
    const hashes = async () => Promise.all([a.core.stateHash(access.space), b.core.stateHash(access.space)]);
    await waitFor(async () => {
      const [x, y] = await hashes();
      return x === y ? x : '';
    }, 20_000, 'clients to converge after the noise');
    expect(await a.core.query({ space: access.space, type: 'note' }).once()).toHaveLength(60 + 20 + 1);
    expect(await b.core.query({ space: access.space, type: 'note' }).once()).toHaveLength(60 + 20 + 1);
  }, 60_000);
});
