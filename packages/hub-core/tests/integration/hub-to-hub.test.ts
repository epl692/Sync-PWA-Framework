// Spec 005 T084 (US4, SC-011 in simulation): two Hubs that hold a link code for the same Space link over Bluetooth and their clients converge.
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryBleLink, MockBleBridge, createSpaceAccess, createTestCore, memberProofs, waitFor } from '@sync/testkit';
import { createBluetoothTransport, createMemoryTrustStore } from '@sync/transport-bluetooth';
import { createHub, createMemoryStore, type HubEvent } from '../../src';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!().catch(() => undefined);
});

async function twoHubs(codes: { a: 'link' | 'serve'; b: 'link' | 'serve' }) {
  const link = new MemoryBleLink({ mtu: 185 });
  const access = await createSpaceAccess();
  const mk = async (name: string, kind: 'link' | 'serve') => {
    const bridge = new MockBleBridge(link);
    const hub = await createHub({ bridge, store: createMemoryStore(), settings: { displayName: name } });
    const events: HubEvent[] = [];
    hub.on((e) => events.push(e)); // before anything can happen
    await hub.start();
    await hub.addServeCode(kind === 'link' ? access.linkCode : access.serveCode);
    cleanups.push(async () => void (await hub.stop().catch(() => undefined), await bridge.close()));
    return { hub, bridge, events, name };
  };
  const a = await mk('Camp A', codes.a);
  const b = await mk('Camp B', codes.b);
  const client = async (name: string, hubName: string) => {
    const t = await createTestCore({ spaces: [access.space] });
    const bt = link.bluetooth();
    const transport = createBluetoothTransport({ proofs: await memberProofs([access], name), confirmHub: async () => true, trustStore: createMemoryTrustStore(), bluetooth: { ...bt, requestDevice: async (x: unknown) => { link.chooser = (ds) => ds.find((d) => d.name === hubName); return bt.requestDevice(x as never); } } as never, isSecureContext: true });
    t.core.addTransport(transport);
    cleanups.push(async () => void (await transport.stop(), await t.core.close()));
    return { core: t.core, transport };
  };
  return { link, access, a, b, client };
}

describe('Hub-to-Hub', () => {
  it('two Hubs with link codes link once, and clients on each Hub converge', async () => {
    const w = await twoHubs({ a: 'link', b: 'link' });
    await waitFor(() => w.a.hub.hubs.linkedFingerprints().length + w.b.hub.hubs.linkedFingerprints().length === 1, 10_000, 'the Hubs to link');
    // exactly one logical link, started by the Hub with the lower fingerprint
    const initiator = w.a.hub.hubs.linkedFingerprints().length === 1 ? w.a : w.b;
    const other = initiator === w.a ? w.b : w.a;
    expect(initiator.hub.fingerprint < other.hub.fingerprint).toBe(true);
    await waitFor(() => initiator.events.some((e) => e.type === 'hub-linked'), 5000, 'the hub-linked event');

    const ca = await w.client('alice', 'Camp A');
    const cb = await w.client('bob', 'Camp B');
    await ca.transport.chooseHub();
    await cb.transport.chooseHub();
    for (let i = 0; i < 15; i++) await ca.core.create(w.access.space, 'note', { from: 'a', i });
    for (let i = 0; i < 10; i++) await cb.core.create(w.access.space, 'note', { from: 'b', i });
    await waitFor(async () => {
      const h = await Promise.all([ca.core.stateHash(w.access.space), cb.core.stateHash(w.access.space)]);
      return h[0] === h[1] ? h[0] : '';
    }, 15_000, 'clients on different Hubs to converge');
    expect(await cb.core.query({ space: w.access.space, type: 'note' }).once()).toHaveLength(25);
    expect(w.a.hub.relay.stats.packets).toBe(25);
    expect(w.b.hub.relay.stats.packets).toBe(25);
  }, 60_000);

  it('a Hub that only holds a serve code (no secret) never initiates a link', async () => {
    const w = await twoHubs({ a: 'serve', b: 'link' });
    await new Promise((r) => setTimeout(r, 400));
    expect(w.a.hub.hubs.linkedFingerprints()).toEqual([]);
    expect(w.a.hub.spaces()[0]!.link).toBe(false);
    expect(w.b.hub.spaces()[0]!.link).toBe(true);
  });

  it('with hubToHub switched off the Hubs stay apart', async () => {
    const link = new MemoryBleLink({ mtu: 185 });
    const access = await createSpaceAccess();
    const hubs = [];
    for (const name of ['One', 'Two']) {
      const bridge = new MockBleBridge(link);
      const hub = await createHub({ bridge, store: createMemoryStore(), settings: { displayName: name, hubToHub: false } });
      await hub.start();
      await hub.addServeCode(access.linkCode);
      cleanups.push(async () => void (await hub.stop().catch(() => undefined), await bridge.close()));
      hubs.push(hub);
    }
    await new Promise((r) => setTimeout(r, 400));
    for (const h of hubs) expect(h.hubs.linkedFingerprints()).toEqual([]);
  });

  it('a Hub that does not serve the Space turns the linking Hub away without learning anything', async () => {
    const link = new MemoryBleLink({ mtu: 185 });
    const mine = await createSpaceAccess();
    const theirs = await createSpaceAccess({ seed: 7, keyByte: 0x55 });
    const hubs = [];
    for (const [name, acc] of [['One', mine], ['Two', theirs]] as const) {
      const bridge = new MockBleBridge(link);
      const hub = await createHub({ bridge, store: createMemoryStore(), settings: { displayName: name } });
      await hub.start();
      await hub.addServeCode(acc.linkCode);
      cleanups.push(async () => void (await hub.stop().catch(() => undefined), await bridge.close()));
      hubs.push(hub);
    }
    await new Promise((r) => setTimeout(r, 500));
    for (const h of hubs) expect(h.hubs.linkedFingerprints()).toEqual([]);
  });
});
