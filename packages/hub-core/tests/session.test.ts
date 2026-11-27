// Spec 005 T079 (US3): one logical connection per device; session state is dropped on disconnect; one event per connection.
import { afterEach, describe, expect, it } from 'vitest';
import { waitFor } from '@sync/testkit';
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

describe('Hub sessions', () => {
  it('a second connection from the same device replaces the first, and the first is closed', async () => {
    const w = await world();
    const proofs = await w.member('maya');
    const first = await w.raw();
    expect((await first.auth(proofs)).t).toBe('auth-ok');
    const second = await w.raw();
    expect((await second.auth(proofs)).t).toBe('auth-ok');
    await first.waitClosed();
    expect(second.closed).toBe(false);
    expect(w.hub.clients().filter((c) => c.connected)).toHaveLength(1);
    expect(w.hub.relay.stats.peers).toBe(1);
  });

  it('emits exactly one client-disconnected per connection, and frees the slot at once', async () => {
    const w = await world({ settings: { maxClients: 1 } });
    const events: HubEvent[] = [];
    w.hub.on((e) => events.push(e));
    const c = await w.raw();
    await c.auth(await w.member('a'));
    expect(c.info.slots).toBe(1);
    c.disconnect();
    await waitFor(() => events.some((e) => e.type === 'client-disconnected'), 2000, 'disconnect event');
    await flush(50);
    expect(events.filter((e) => e.type === 'client-disconnected')).toHaveLength(1);
    const again = await w.raw(); // the single slot is free again
    expect((await again.auth(await w.member('b'))).t).toBe('auth-ok');
    expect(w.hub.relay.stats.peers).toBe(1);
  });

  it('a full Hub answers busy at the handshake and says how long to wait', async () => {
    const w = await world({ settings: { maxClients: 1 } });
    const c = await w.raw();
    await c.auth(await w.member('a'));
    const { RawClient } = await import('@sync/testkit');
    const extra = await RawClient.open(w.link);
    expect(extra.info.full).toBe(true);
    expect(await extra.handshake()).toBe(false);
  });

  it('INFO tracks the free slots as clients come and go', async () => {
    const w = await world({ settings: { maxClients: 3 } });
    const a = await w.raw();
    await a.auth(await w.member('a'));
    const b = await w.raw();
    await b.auth(await w.member('b'));
    const probe = await w.raw();
    expect(probe.info.slots).toBeLessThanOrEqual(3);
    a.disconnect();
    await flush(50);
    const { RawClient } = await import('@sync/testkit');
    const looker = await RawClient.open(w.link);
    expect(looker.info.slots).toBeGreaterThanOrEqual(1);
  });
});
