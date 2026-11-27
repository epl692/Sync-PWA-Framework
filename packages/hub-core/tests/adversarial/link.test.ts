// Spec 005 T054 (US2): hostile clients. Every case must end with nothing stored, nothing learned, and the Hub still working.
import { afterEach, describe, expect, it } from 'vitest';
import { createSpaceAccess, memberProofs, waitFor, RawClient } from '@sync/testkit';
import { b64uEncode } from '@sync/transport-bluetooth/link';
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

describe('replay and tampering', () => {
  it('a proof captured in one session fails in another session (bound to both nonces)', async () => {
    const w = await world();
    const proofs = await w.member('victim');
    const a = await w.raw();
    const good = await a.authMessage(proofs);
    expect((await a.auth(proofs)).t).toBe('auth-ok');
    const sig = (good as { spaces: Array<{ sig: string }> }).spaces[0]!.sig;

    const b = await w.raw();
    const r = await b.auth(proofs, { spaces: [{ space: w.access.space, epoch: w.access.epoch, sig }] });
    expect(r).toEqual({ t: 'reject', code: 'not-served' });
  });

  it('a proof for the wrong epoch, or computed over a tampered nonce, fails', async () => {
    const w = await world();
    const proofs = await w.member('m');
    const a = await w.raw();
    expect((await a.auth(proofs, { spaces: [{ space: w.access.space, epoch: w.access.epoch + 1 }] })).code).toBe('not-served');
    const b = await w.raw();
    // the Space proof is computed over a nonce that is not this session's; the device proof is right, so this is a rejection, not a strike
    const wrong = b64uEncode(await proofs.proveSpace({ space: w.access.space, epoch: w.access.epoch, hubFingerprint: b.hubFingerprint, nc: new Uint8Array(16).fill(1), nh: b.nh }));
    expect((await b.auth(proofs, { spaces: [{ space: w.access.space, epoch: w.access.epoch, sig: wrong }] })).code).toBe('not-served');
  });

  it('a device proof that does not match the device ID is a strike, not a login', async () => {
    const w = await world();
    const a = await w.raw();
    const proofs = await w.member('m');
    const msg = (await a.authMessage(proofs)) as unknown as Record<string, unknown>;
    msg.device = 'AAAAAAAAAAAAAAAAAAAAAAAAAA'; // someone else's ID
    await a.sendControl(msg);
    await flush(100);
    expect(a.controls.filter((c) => c.t === 'auth-ok')).toEqual([]);
    expect(w.hub.clients()).toEqual([]);
  });
});

describe('claims in automatic Space mode', () => {
  it('a claim for a Space that is already served is ignored (the first registered key wins)', async () => {
    const w = await world({ settings: { autoSpaces: true } });
    const attacker = await createSpaceAccess({ keyByte: 0x66 }); // same Space ID, different epoch key
    const proofs = await memberProofs([attacker], 'attacker');
    const c = await w.raw();
    const r = await c.auth(proofs, { claim: true });
    expect(r).toEqual({ t: 'reject', code: 'not-served' });
    expect(w.hub.spaces()).toHaveLength(1);
    expect(w.hub.spaces()[0]!.source).toBe('code');
  });

  it('a claim whose proof does not verify under the claimed key is ignored', async () => {
    const w = await world({ settings: { autoSpaces: true }, serve: false });
    const fresh = await createSpaceAccess({ seed: 7, keyByte: 0x55 });
    const proofs = await memberProofs([fresh], 'x');
    const c = await w.raw();
    const r = await c.auth(proofs, { claim: true, spaces: [{ space: fresh.space, epoch: fresh.epoch, sig: 'A'.repeat(86) }] });
    expect(r.code).toBe('not-served');
    expect(w.hub.spaces()).toEqual([]);
  });
});

describe('malformed input', () => {
  it('an auth with too many Spaces is a strike and is never processed', async () => {
    const w = await world();
    const a = await w.raw();
    const proofs = await w.member('m');
    const msg = (await a.authMessage(proofs)) as unknown as { spaces: unknown[] };
    msg.spaces = Array.from({ length: 100 }, (_, i) => ({ space: `S${i}`, epoch: 0, sig: 'x' }));
    await a.sendControl(msg as never);
    await flush(100);
    expect(a.controls.filter((c) => c.t === 'auth-ok' || c.t === 'reject')).toEqual([]);
  });

  it('any control message other than auth before auth-ok is a strike; 3 close the connection', async () => {
    const w = await world();
    const a = await w.raw();
    for (let i = 0; i < 3; i++) await a.sendControl({ t: 'probe-result', received: [], notify: 20 });
    await a.waitClosed();
  });

  it('garbage frames never crash the Hub: valid clients still work afterwards', async () => {
    const w = await world();
    const bad = await RawClient.open(w.link);
    for (let i = 0; i < 10; i++) await bad.rawFrame(Uint8Array.of(0xff, i, 1, 2, 3)).catch(() => undefined); // the Hub hangs up after 3 strikes
    await bad.waitClosed();
    const good = await w.raw();
    expect((await good.auth(await w.member('ok'))).t).toBe('auth-ok');
  });

  it('a handshake with a version range that does not overlap is closed without an answer', async () => {
    const w = await world();
    const c = await RawClient.open(w.link);
    expect(c.info.v).toEqual([1, 1]);
    const { startClientHandshake } = await import('@sync/transport-bluetooth/link');
    const hs = await startClientHandshake([5, 6]);
    (c as unknown as { build(): void }).build();
    c.channel.sendPlain(hs.hello);
    await c.waitClosed();
  });
});

describe('rate limits and strikes', () => {
  it('limits authentication attempts to 6 per minute per device, then answers busy', async () => {
    const w = await world({ fake: true, settings: { maxClients: 20 } });
    const proofs = await w.member('flood');
    const verdicts: string[] = [];
    for (let i = 0; i < 8; i++) {
      const c = await w.raw();
      const r = await c.auth(proofs).catch(() => ({ t: 'timeout' }) as never);
      verdicts.push(String(r.t === 'reject' ? r.code : r.t));
      c.disconnect();
      await w.clock.advance(100);
    }
    expect(verdicts.slice(0, 6)).toEqual(Array(6).fill('auth-ok'));
    expect(verdicts.slice(6)).toEqual(['busy', 'busy']);
    await w.clock.advance(61_000);
    const later = await w.raw();
    expect((await later.auth(proofs)).t).toBe('auth-ok');
  });

  it('limits handshakes overall to 30 per minute, answering busy cheaply beyond that', async () => {
    const w = await world({ fake: true, settings: { maxClients: 50 } });
    let busy = 0;
    for (let i = 0; i < 34; i++) {
      const c = await RawClient.open(w.link);
      if (!(await c.handshake())) busy++;
      c.disconnect();
      await w.clock.advance(50);
    }
    expect(busy).toBe(4);
  });

  it('3 strikes from an authenticated device within 10 minutes disconnect it and block it for 15 minutes', async () => {
    const w = await world({ fake: true });
    const proofs = await w.member('rogue');
    const c = await w.raw();
    expect((await c.auth(proofs)).t).toBe('auth-ok');
    for (let i = 0; i < 3; i++) await c.sendCore(Uint8Array.of(0xb1)); // lane bytes with no registered handler are not a strike...
    for (let i = 0; i < 3; i++) await c.rawFrame(Uint8Array.of(0xff, 0)); // ...but reserved-type frames are
    await c.waitClosed();
    const again = await w.raw();
    expect(await again.auth(proofs)).toEqual({ t: 'reject', code: 'blocked' });
    again.disconnect();
    await w.clock.advance(15 * 60_000 + 1000);
    const later = await w.raw();
    expect((await later.auth(proofs)).t).toBe('auth-ok');
  });

  it('an unauthenticated connection is dropped after 20 seconds', async () => {
    const w = await world({ fake: true });
    const c = await w.raw();
    await w.clock.advance(19_000);
    expect(c.closed).toBe(false);
    await w.clock.advance(2_000);
    await waitFor(() => c.closed, 3000, 'close');
  });
});
