// Spec 005 T057 (US2): automatic Space mode (off by default), trust on first use, caps.
import { afterEach, describe, expect, it } from 'vitest';
import { createSpaceAccess, memberProofs } from '@sync/testkit';
import { MAX_AUTO_SPACES } from '../../src';
import { makeWorld, type World } from '../support/world';

const worlds: World[] = [];
afterEach(async () => {
  while (worlds.length) await worlds.pop()!.stop().catch(() => undefined);
});
const world = async (o?: Parameters<typeof makeWorld>[0]) => {
  const w = await makeWorld(o);
  worlds.push(w);
  return w;
};

describe('automatic Space mode', () => {
  it('is off by default: a Space the owner did not add is rejected and nothing is registered', async () => {
    const w = await world({ serve: false });
    expect(w.hub.settings().autoSpaces).toBe(false);
    const fresh = await createSpaceAccess({ seed: 3, keyByte: 0x77 });
    const c = await w.raw();
    expect(await c.auth(await memberProofs([fresh], 'x'), { claim: true })).toEqual({ t: 'reject', code: 'not-served' });
    expect(w.hub.spaces()).toEqual([]);
    expect(w.hub.relay.stats.spaces).toBe(0);
  });

  it('with it on, the first valid claim registers the Space as automatic and the claimant is let in', async () => {
    const w = await world({ serve: false, settings: { autoSpaces: true } });
    const fresh = await createSpaceAccess({ seed: 3, keyByte: 0x77 });
    const events: Array<{ auto: boolean }> = [];
    w.hub.on((e) => e.type === 'space-added' && events.push({ auto: e.auto }));
    const c = await w.raw();
    expect(c.info.auto).toBe(true);
    const r = await c.auth(await memberProofs([fresh], 'x'), { claim: true });
    expect(r).toMatchObject({ t: 'auth-ok', accepted: [fresh.space] });
    expect(w.hub.spaces()).toMatchObject([{ space: fresh.space, source: 'auto' }]);
    expect(events).toEqual([{ auto: true }]);
  });

  it('a second client with a different key for the same Space is rejected (the first key stays)', async () => {
    const w = await world({ serve: false, settings: { autoSpaces: true } });
    const first = await createSpaceAccess({ seed: 3, keyByte: 0x77 });
    const squatter = await createSpaceAccess({ seed: 3, keyByte: 0x88 }); // same Space ID, other key
    const a = await w.raw();
    expect((await a.auth(await memberProofs([first], 'a'), { claim: true })).t).toBe('auth-ok');
    const b = await w.raw();
    expect(await b.auth(await memberProofs([squatter], 'b'), { claim: true })).toEqual({ t: 'reject', code: 'not-served' });
    const c = await w.raw();
    expect((await c.auth(await memberProofs([first], 'c'), { claim: true })).t).toBe('auth-ok'); // real members still get in
  });

  it('stops registering after the cap of automatic Spaces', async () => {
    const w = await world({ serve: false, settings: { autoSpaces: true, maxClients: 40 } });
    for (let i = 0; i < MAX_AUTO_SPACES; i++) {
      const a = await createSpaceAccess({ seed: 20 + i, keyByte: 0x10 + i });
      const c = await w.raw();
      expect((await c.auth(await memberProofs([a], `c${i}`), { claim: true })).t).toBe('auth-ok');
      c.disconnect();
    }
    const over = await createSpaceAccess({ seed: 99, keyByte: 0x99 });
    const c = await w.raw();
    expect(await c.auth(await memberProofs([over], 'over'), { claim: true })).toEqual({ t: 'reject', code: 'not-served' });
    expect(w.hub.spaces()).toHaveLength(MAX_AUTO_SPACES);
  });

  it('automatic Spaces can be removed by the owner, and a Space added with a code is not flagged automatic', async () => {
    const w = await world({ settings: { autoSpaces: true } });
    const fresh = await createSpaceAccess({ seed: 3, keyByte: 0x77 });
    const c = await w.raw();
    await c.auth(await memberProofs([fresh], 'x'), { claim: true });
    expect(w.hub.spaces().map((s) => s.source).sort()).toEqual(['auto', 'code']);
    await w.hub.removeSpace(fresh.space, { deleteStored: true });
    expect(w.hub.spaces().map((s) => s.source)).toEqual(['code']);
  });
});
