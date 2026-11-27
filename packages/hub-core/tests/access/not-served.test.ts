// Spec 005 T053 (US2): strangers learn nothing, and "unknown Space" and "bad proof" look the same.
import { afterEach, describe, expect, it } from 'vitest';
import { b64urlEncode, encodeMessage } from '@sync/core';
import { createSpaceAccess, memberProofs, remoteEnvelope, waitFor } from '@sync/testkit';
import { parseInfo } from '@sync/transport-bluetooth/link';
import { makeWorld, flush, type World } from '../support/world';

const worlds: World[] = [];
afterEach(async () => {
  while (worlds.length) await worlds.pop()!.stop().catch(() => undefined);
});
const world = async (o?: Parameters<typeof makeWorld>[0]) => {
  const w = await makeWorld(o);
  worlds.push(w);
  return w;
};

describe('a client that is not a member', () => {
  it('gets the identical rejection for an unknown Space and for a wrongly proven one', async () => {
    const w = await world();
    const stranger = await createSpaceAccess({ seed: 9, keyByte: 0x33 });
    const a = await w.raw();
    const unknown = await a.auth(await memberProofs([stranger], 'a'));
    const b = await w.raw();
    const wrong = await b.auth(await w.member('b'), { spaces: [{ space: w.access.space, epoch: w.access.epoch, sig: 'A'.repeat(86) }] });
    expect(unknown).toEqual({ t: 'reject', code: 'not-served' });
    expect(wrong).toEqual({ t: 'reject', code: 'not-served' });
    await a.waitClosed();
    await b.waitClosed();
    expect(w.hub.clients()).toEqual([]);
  });

  it('a mixed request is answered only for what it asked: accepted and rejected, never the Hub\'s other Spaces', async () => {
    const w = await world();
    const other = await createSpaceAccess({ seed: 9, keyByte: 0x33 });
    await w.hub.addServeCode((await createSpaceAccess({ seed: 5, keyByte: 0x44 })).serveCode); // a third Space the client never mentions
    const c = await w.raw();
    const r = await c.auth(await memberProofs([w.access, other], 'm'));
    expect(r).toMatchObject({ t: 'auth-ok', accepted: [w.access.space], rejected: [other.space] });
    expect(JSON.stringify(r)).not.toContain('"S');
    expect((r.accepted as string[]).length + (r.rejected as string[]).length).toBe(2);
  });

  it('before auth, INFO is all anyone learns: no Space, packet or client information', async () => {
    const w = await world();
    const m = await w.raw();
    await m.auth(await w.member('m'));
    const c = await w.raw();
    const info = parseInfo(await c.gatt.info())!;
    expect(Object.keys(info).sort()).toEqual(['fp', 'full', 'maxWrite', 'mode', 'name', 'slots', 'v']);
    expect(JSON.stringify(info)).not.toContain(w.access.space);
    // nothing arrives from the Hub unprompted on an unauthenticated connection
    await flush(100);
    expect(c.controls).toEqual([]);
    expect(c.core).toEqual([]);
  });

  it('core messages before auth-ok are ignored and counted against the connection', async () => {
    const w = await world();
    const c = await w.raw();
    for (let i = 0; i < 3; i++) await c.sendCore(new TextEncoder().encode('{"t":"hello"}'));
    await c.waitClosed();
    expect(w.hub.relay.stats.peers).toBe(0);
  });

  it('what the Hub stores is exactly the bytes it was sent (original bytes, never re-encoded)', async () => {
    const w = await world();
    const c = await w.raw();
    await c.auth(await w.member('m'));
    await c.sendCore(encodeMessage({ t: 'hello', protocol: { min: 1, max: 1 }, device: 'D', spaces: [w.access.space], relay: true }));
    const e = await remoteEnvelope({ obj: 'o1', op: 'create', type: 't', fields: { a: 1 } }, { author: 'AUTH', seq: 1, space: w.access.space });
    await c.sendCore(encodeMessage({ t: 'packets', space: w.access.space, items: [b64urlEncode(e.raw)] }));
    await waitFor(() => w.hub.relay.stats.packets === 1, 3000, 'packet to be stored');
    expect(w.hub.relay.inspect().spaces[0]!.packets[0]).toEqual(e.raw);
    expect((await w.store.getPackets(w.access.space, ['AUTH:1']))[0]!.bytes).toEqual(e.raw);
  });
});
