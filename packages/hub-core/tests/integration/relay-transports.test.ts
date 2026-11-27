// Spec 005 T085 (US4): a Hub with another transport attached relays between Bluetooth clients and that transport, without loops,
// and only for the Spaces it serves.
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryBleLink, MemoryNetwork, MockBleBridge, createSpaceAccess, createTestCore, memberProofs, waitFor } from '@sync/testkit';
import { createBluetoothTransport, createMemoryTrustStore } from '@sync/transport-bluetooth';
import { createHub, createMemoryStore } from '../../src';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!().catch(() => undefined);
});

async function world() {
  const link = new MemoryBleLink({ mtu: 185 });
  const bridge = new MockBleBridge(link);
  const hub = await createHub({ bridge, store: createMemoryStore() });
  await hub.start();
  const access = await createSpaceAccess();
  const unserved = await createSpaceAccess({ seed: 4, keyByte: 0x44 });
  await hub.addServeCode(access.serveCode);
  cleanups.push(async () => void (await hub.stop(), await bridge.close()));
  const net = new MemoryNetwork();
  const detach = await hub.attachTransport(net.transport('hub', 'internet'));
  cleanups.push(async () => detach());
  const cloud = await createTestCore({ spaces: [access.space, unserved.space] });
  cloud.core.addTransport(net.transport('cloud', 'internet'));
  cleanups.push(async () => void (await cloud.core.close()));
  net.link('hub', 'cloud', 'internet');
  const phone = async (name: string) => {
    const t = await createTestCore({ spaces: [access.space] });
    const transport = createBluetoothTransport({ proofs: await memberProofs([access], name), confirmHub: async () => true, trustStore: createMemoryTrustStore(), bluetooth: link.bluetooth() as never, isSecureContext: true });
    t.core.addTransport(transport);
    cleanups.push(async () => void (await transport.stop(), await t.core.close()));
    return { core: t.core, transport };
  };
  return { hub, access, unserved, cloud: cloud.core, phone };
}

describe('Hub with another transport attached', () => {
  it('relays both ways between a Bluetooth client and the other network, with no duplicates and no loops', async () => {
    const w = await world();
    const a = await w.phone('alice');
    await a.transport.chooseHub();
    for (let i = 0; i < 8; i++) await a.core.create(w.access.space, 'note', { from: 'phone', i });
    await waitFor(async () => (await w.cloud.query({ space: w.access.space, type: 'note' }).once()).length === 8, 10_000, 'the cloud to receive the phone\'s notes');
    for (let i = 0; i < 5; i++) await w.cloud.create(w.access.space, 'note', { from: 'cloud', i });
    await waitFor(async () => (await a.core.query({ space: w.access.space, type: 'note' }).once()).length === 13, 10_000, 'the phone to receive the cloud\'s notes');
    expect(await a.core.stateHash(w.access.space)).toBe(await w.cloud.stateHash(w.access.space));
    expect(w.hub.relay.stats.packets).toBe(13); // stored once each
  }, 60_000);

  it('only Spaces the Hub serves cross over', async () => {
    const w = await world();
    const a = await w.phone('alice');
    await a.transport.chooseHub();
    await w.cloud.create(w.unserved.space, 'secret', { x: 1 });
    await w.cloud.create(w.access.space, 'note', { x: 1 });
    await waitFor(async () => (await a.core.query({ space: w.access.space, type: 'note' }).once()).length === 1, 10_000, 'the served Space to arrive');
    await new Promise((r) => setTimeout(r, 200));
    expect(w.hub.relay.inspect().spaces.map((s) => s.space)).toEqual([w.access.space]);
    expect(await a.core.query({ space: w.unserved.space, type: 'secret' }).once()).toHaveLength(0);
  }, 60_000);
});
