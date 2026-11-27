/** A Hub on a simulated radio with one served Space, for protocol, access and approval tests. */
import { MemoryBleLink, MockBleBridge, RawClient, createFakeTimers, createSpaceAccess, memberProofs, type FakeTimers, type FixtureProofs, type SpaceAccess } from '@sync/testkit';
import { createHub, createMemoryStore, type Hub, type HubSettings } from '../../src';

export interface World {
  link: MemoryBleLink;
  bridge: MockBleBridge;
  hub: Hub;
  access: SpaceAccess;
  clock: FakeTimers;
  store: ReturnType<typeof createMemoryStore>;
  /** A member device (proofs for the served Space). */
  member(name?: string): Promise<FixtureProofs>;
  /** A raw client past the handshake, ready to send auth. */
  raw(): Promise<RawClient>;
  stop(): Promise<void>;
}

export async function makeWorld(o: { settings?: Partial<HubSettings>; fake?: boolean; air?: ConstructorParameters<typeof MemoryBleLink>[0]; serve?: boolean } = {}): Promise<World> {
  const link = new MemoryBleLink(o.air ?? { mtu: 185 });
  const bridge = new MockBleBridge(link);
  const clock = createFakeTimers();
  const store = createMemoryStore();
  const hub = await createHub({
    bridge,
    store,
    ...(o.settings ? { settings: o.settings } : {}),
    ...(o.fake ? { now: clock.now, timers: clock.timers } : {}),
  });
  await hub.start();
  const access = await createSpaceAccess();
  if (o.serve !== false) await hub.addServeCode(access.serveCode);
  return {
    link,
    bridge,
    hub,
    access,
    clock,
    store,
    member: (name) => memberProofs([access], name),
    async raw() {
      const c = await RawClient.open(link);
      if (!(await c.handshake())) throw new Error('the Hub answered busy');
      return c;
    },
    stop: async () => void (await hub.stop(), await bridge.close()),
  };
}

export const flush = (ms = 20) => new Promise((r) => setTimeout(r, ms));
