// Spec 005 T083 (US4, SC-006): a client that is gone still delivers its changes to a client that connects later, even across a Hub restart.
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryBleLink, MockBleBridge, createSpaceAccess, createTestCore, memberProofs, waitFor } from '@sync/testkit';
import { createBluetoothTransport, createMemoryTrustStore } from '@sync/transport-bluetooth';
import { createHub, createMemoryFs, createSegmentStore } from '../../src';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!().catch(() => undefined);
});

describe('store and forward', () => {
  it('A writes and leaves; B connects ten minutes later and receives everything, exactly once, also after a Hub restart', async () => {
    const link = new MemoryBleLink({ mtu: 185 });
    const fs = createMemoryFs();
    const access = await createSpaceAccess();
    const startHub = async () => {
      const bridge = new MockBleBridge(link);
      const hub = await createHub({ bridge, store: createSegmentStore(fs) });
      await hub.start();
      if (!hub.spaces().length) await hub.addServeCode(access.serveCode);
      cleanups.push(async () => void (await hub.stop().catch(() => undefined), await bridge.close()));
      return { hub, bridge };
    };
    const client = async (name: string) => {
      const t = await createTestCore({ spaces: [access.space] });
      const transport = createBluetoothTransport({ proofs: await memberProofs([access], name), confirmHub: async () => true, trustStore: createMemoryTrustStore(), bluetooth: link.bluetooth() as never, isSecureContext: true });
      t.core.addTransport(transport);
      cleanups.push(async () => void (await transport.stop(), await t.core.close()));
      return { core: t.core, transport };
    };

    let h = await startHub();
    const a = await client('alice');
    await a.transport.chooseHub();
    for (let i = 0; i < 40; i++) await a.core.create(access.space, 'note', { i });
    await waitFor(() => h.hub.relay.stats.packets === 40, 10_000, 'the Hub to hold all of it');
    await new Promise((r) => setTimeout(r, 50)); // let the writes reach the store
    await a.transport.disconnectHub(a.transport.connections()[0]!.fingerprint);
    await a.transport.stop();

    // the Hub restarts: a new process on the same files
    await h.hub.stop();
    await h.bridge.close();
    h = await startHub();
    expect(h.hub.relay.stats.packets).toBe(40); // restored from disk
    expect(h.hub.spaces()).toHaveLength(1);

    const b = await client('bob');
    await b.transport.chooseHub();
    await waitFor(async () => (await b.core.query({ space: access.space, type: 'note' }).once()).length === 40, 10_000, 'bob to receive everything');
    expect(await b.core.stateHash(access.space)).toBe(await a.core.stateHash(access.space));
    expect(h.hub.relay.stats.packets).toBe(40); // nothing was stored twice
  }, 60_000);

  it('every packet is applied exactly once with several clients and no loops', async () => {
    const link = new MemoryBleLink({ mtu: 185 });
    const bridge = new MockBleBridge(link);
    const hub = await createHub({ bridge, store: createSegmentStore(createMemoryFs()) });
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
    const cs = await Promise.all(['a', 'b', 'c', 'd'].map(make));
    for (const c of cs) await c.transport.chooseHub();
    for (let i = 0; i < 10; i++) for (const [k, c] of cs.entries()) await c.core.create(access.space, 'note', { k, i });
    await waitFor(async () => {
      const h = await Promise.all(cs.map((c) => c.core.stateHash(access.space)));
      return h.every((x) => x === h[0]) ? h[0] : '';
    }, 15_000, 'all four to converge');
    for (const c of cs) expect(await c.core.query({ space: access.space, type: 'note' }).once()).toHaveLength(40);
    expect(hub.relay.stats.packets).toBe(40);
  }, 60_000);
});
