// Spec 005 T056 (US2): open mode (default) and approval mode.
import { afterEach, describe, expect, it } from 'vitest';
import { waitFor } from '@sync/testkit';
import { createBluetoothTransport, createMemoryTrustStore } from '@sync/transport-bluetooth';
import type { HubEvent } from '../src';
import { makeWorld, flush, type World } from './support/world';

const worlds: World[] = [];
afterEach(async () => {
  while (worlds.length) await worlds.pop()!.stop().catch(() => undefined);
});
const world = async (o?: Parameters<typeof makeWorld>[0]) => {
  const w = await makeWorld(o);
  worlds.push(w);
  return w;
};

describe('open mode (default)', () => {
  it('a proven member syncs with no approval step, and is listed as trusted', async () => {
    const w = await world();
    expect(w.hub.settings().accessMode).toBe('open');
    const c = await w.raw();
    expect((await c.auth(await w.member('maya'))).t).toBe('auth-ok');
    expect(w.hub.clients()).toMatchObject([{ name: 'maya', state: 'trusted', connected: true }]);
  });
});

describe('approval mode', () => {
  it('holds a new device as pending and exchanges nothing until the owner approves', async () => {
    const w = await world({ settings: { accessMode: 'approval' } });
    const events: HubEvent[] = [];
    w.hub.on((e) => events.push(e));
    const proofs = await w.member('maya');
    const c = await w.raw();
    const first = await c.auth(proofs);
    expect(first.t).toBe('pending');
    expect(events.some((e) => e.type === 'approval-needed')).toBe(true);
    expect(w.hub.clients()).toMatchObject([{ state: 'pending', connected: true }]);
    // while pending, sync messages are not accepted
    await c.sendCore(new TextEncoder().encode('{"t":"hello"}'));
    await flush(50);
    expect(w.hub.relay.stats.peers).toBe(0);
    expect(c.controls.some((m) => m.t === 'auth-ok')).toBe(false);

    await w.hub.approve(proofs.deviceId);
    await c.waitControl(['auth-ok']);
    expect(w.hub.clients()).toMatchObject([{ state: 'trusted', connected: true }]);
    await waitFor(() => w.hub.relay.stats.peers === 1, 2000, 'peer to be registered with the relay');
  });

  it('deny rejects and blocks the device; unblock makes it unknown again', async () => {
    const w = await world({ settings: { accessMode: 'approval' } });
    const proofs = await w.member('rogue');
    const c = await w.raw();
    expect((await c.auth(proofs)).t).toBe('pending');
    await w.hub.deny(proofs.deviceId);
    await c.waitControl(['reject']);
    expect(c.controls.find((m) => m.t === 'reject')).toMatchObject({ code: 'denied' });
    await c.waitClosed();
    const again = await w.raw();
    expect(await again.auth(proofs)).toEqual({ t: 'reject', code: 'blocked' });
    await w.hub.unblock(proofs.deviceId);
    const later = await w.raw();
    expect((await later.auth(proofs)).t).toBe('pending');
  });

  it('a pending device that is not decided within 10 minutes is turned away', async () => {
    const w = await world({ fake: true, settings: { accessMode: 'approval' } });
    const c = await w.raw();
    expect((await c.auth(await w.member('slow'))).t).toBe('pending');
    await w.clock.advance(9 * 60_000);
    expect(c.closed).toBe(false);
    await w.clock.advance(61_000);
    await c.waitControl(['reject']);
    expect(c.controls.find((m) => m.t === 'reject')).toMatchObject({ code: 'denied' });
  });

  it('a pending device is not dropped by the 20 second authentication deadline', async () => {
    const w = await world({ fake: true, settings: { accessMode: 'approval' } });
    const c = await w.raw();
    await c.auth(await w.member('patient'));
    await w.clock.advance(60_000);
    expect(c.closed).toBe(false);
  });

  it('switching modes never revokes a trusted device; switching to open lets pending devices in', async () => {
    const w = await world();
    const trusted = await w.member('regular');
    const t = await w.raw();
    expect((await t.auth(trusted)).t).toBe('auth-ok');
    t.disconnect();
    await w.hub.updateSettings({ accessMode: 'approval' });
    const t2 = await w.raw();
    expect((await t2.auth(trusted)).t).toBe('auth-ok'); // still trusted, no new approval
    const newcomer = await w.member('new');
    const n = await w.raw();
    expect((await n.auth(newcomer)).t).toBe('pending');
    await w.hub.updateSettings({ accessMode: 'open' });
    await n.waitControl(['auth-ok']);
  });

  it('INFO reports the mode so a client can tell before connecting', async () => {
    const w = await world({ settings: { accessMode: 'approval' } });
    const c = await w.raw();
    expect(c.info.mode).toBe('approval');
  });

  it('an owner block disconnects a connected device and keeps it out', async () => {
    const w = await world();
    const proofs = await w.member('maya');
    const c = await w.raw();
    await c.auth(proofs);
    await w.hub.block(proofs.deviceId);
    await c.waitClosed();
    const again = await w.raw();
    expect(await again.auth(proofs)).toEqual({ t: 'reject', code: 'blocked' });
  });

  it('records survive a restart (approved stays approved, blocked stays blocked)', async () => {
    const w = await world({ settings: { accessMode: 'approval' } });
    const p = await w.member('maya');
    const c = await w.raw();
    await c.auth(p);
    await w.hub.approve(p.deviceId);
    await flush(30);
    const saved = await w.store.clients();
    expect(saved).toMatchObject([{ state: 'trusted', name: 'maya' }]);
  });

  it('the client app sees "pending" while it waits and "syncing" once approved', async () => {
    const w = await world({ settings: { accessMode: 'approval' } });
    const proofs = await w.member('maya');
    const t = createBluetoothTransport({ proofs, confirmHub: async () => true, trustStore: createMemoryTrustStore(), bluetooth: w.link.bluetooth() as never, isSecureContext: true });
    await t.start();
    const done = t.chooseHub();
    await waitFor(() => t.connections()[0]?.state === 'pending', 3000, 'pending state');
    expect(t.connections()[0]!.detail).toMatch(/Hub owner/);
    expect(t.state).toBe('idle'); // not connected yet
    await w.hub.approve(proofs.deviceId);
    const info = await done;
    expect(info.state).toBe('syncing');
    expect(info.acceptedSpaces).toEqual([w.access.space]);
    expect(t.state).toBe('ready');
    await t.stop();
  });
});
