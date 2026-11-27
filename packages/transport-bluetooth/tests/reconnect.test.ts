// Spec 005 T075 (US3): a trusted Hub that comes back in range is reconnected to without re-pairing, where the browser allows it.
import { afterEach, describe, expect, it } from 'vitest';
import { createLinkFixture, waitFor, type LinkFixture } from '@sync/testkit';
import { createBluetoothTransport, createMemoryTrustStore, type BluetoothLike } from '../src/index';

const fixtures: LinkFixture[] = [];
afterEach(async () => {
  while (fixtures.length) await fixtures.pop()!.stop().catch(() => undefined);
});

async function setup(o: { getDevices: boolean; autoReconnect?: boolean }) {
  const fx = await createLinkFixture({ air: { mtu: 185, getDevices: o.getDevices } });
  fixtures.push(fx);
  const bt = fx.link.bluetooth();
  let chooser = 0;
  const counted: BluetoothLike = { ...bt, requestDevice: (x: unknown) => (chooser++, bt.requestDevice(x as never)) } as never;
  if (bt.getDevices) (counted as { getDevices?: unknown }).getDevices = bt.getDevices.bind(bt);
  let confirms = 0;
  const t = createBluetoothTransport({
    proofs: await fx.newClient('phone'),
    confirmHub: async () => (confirms++, true),
    trustStore: createMemoryTrustStore(),
    bluetooth: counted as never,
    isSecureContext: true,
    ...(o.autoReconnect === undefined ? {} : { autoReconnect: o.autoReconnect }),
    reconnect: { minMs: 20, maxMs: 80, maxAttempts: 40 },
  });
  const events: string[] = [];
  t.on('peerConnected', () => events.push('up'));
  t.on('peerDisconnected', (_p, r) => events.push(`down:${r}`));
  await t.start();
  return { fx, t, events, chooserCalls: () => chooser, confirms: () => confirms };
}

describe('reconnecting to a trusted Hub', () => {
  it('walks out of range and back: reconnects by itself with no chooser and no new confirmation', async () => {
    const s = await setup({ getDevices: true });
    await s.t.chooseHub();
    expect(s.chooserCalls()).toBe(1);
    s.fx.bridge.setInRange(false);
    await waitFor(() => s.events.some((e) => e.startsWith('down')), 3000, 'drop');
    expect(s.t.connections()).toEqual([]);
    await new Promise((r) => setTimeout(r, 150)); // a few failed attempts while out of range
    s.fx.bridge.setInRange(true);
    await waitFor(() => s.events.filter((e) => e === 'up').length === 2, 5000, 'reconnect');
    expect(s.chooserCalls()).toBe(1); // never asked the user to pick again
    expect(s.confirms()).toBe(1);
    expect(s.t.state).toBe('ready');
  });

  it('the user disconnecting on purpose is never undone by automatic reconnection', async () => {
    const s = await setup({ getDevices: true });
    await s.t.chooseHub();
    await s.t.disconnectHub(s.fx.identity.fingerprintText);
    await new Promise((r) => setTimeout(r, 300));
    expect(s.t.connections()).toEqual([]);
    expect(s.events.filter((e) => e === 'up')).toHaveLength(1);
    // but they can ask for it explicitly
    await s.t.reconnect(s.fx.identity.fingerprintText);
    expect(s.events.filter((e) => e === 'up')).toHaveLength(2);
  });

  it('autoReconnect: false never reconnects on its own', async () => {
    const s = await setup({ getDevices: true, autoReconnect: false });
    await s.t.chooseHub();
    s.fx.bridge.setInRange(false);
    await waitFor(() => s.events.some((e) => e.startsWith('down')), 3000, 'drop');
    s.fx.bridge.setInRange(true);
    await new Promise((r) => setTimeout(r, 300));
    expect(s.events.filter((e) => e === 'up')).toHaveLength(1);
  });

  it('where the browser cannot find permitted devices, reconnect() says a gesture is needed and the status asks for it', async () => {
    const s = await setup({ getDevices: false });
    await s.t.chooseHub();
    await expect(s.t.reconnect(s.fx.identity.fingerprintText)).rejects.toMatchObject({ code: 'needs-gesture' });
    s.fx.bridge.setInRange(false);
    await waitFor(() => s.events.some((e) => e.startsWith('down')), 3000, 'drop');
    await waitFor(() => /Find a Hub/.test((s.t.status() as { message?: string }).message ?? ''), 3000, 'status asks for a gesture');
    s.fx.bridge.setInRange(true);
    await s.t.chooseHub(); // the one-tap path still works, with no new confirmation
    expect(s.confirms()).toBe(1);
  });

  it('a Hub that was closed by its owner (bye) is retried with backoff, not hammered', async () => {
    const s = await setup({ getDevices: true });
    await s.t.chooseHub();
    const peer = s.fx.peers.at(-1)!;
    await s.fx.server.disconnect(peer.id, 'owner');
    await waitFor(() => s.events.filter((e) => e === 'up').length === 2, 5000, 'second connection');
  });
});
