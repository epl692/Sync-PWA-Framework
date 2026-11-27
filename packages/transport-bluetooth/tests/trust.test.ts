// Spec 005 T055 (US2): first-use confirmation, pinning, identity change, and the errors a person sees.
import { afterEach, describe, expect, it } from 'vitest';
import { createLinkFixture, createSpaceAccess, memberProofs, type LinkFixture } from '@sync/testkit';
import { encodeInfo } from '../src/link';
import { createBluetoothTransport, createMemoryTrustStore, HubLinkError, type HubCandidate, type TrustedHubStore } from '../src/index';

const fixtures: LinkFixture[] = [];
afterEach(async () => {
  while (fixtures.length) await fixtures.pop()!.stop().catch(() => undefined);
});
const fixture = async (o?: Parameters<typeof createLinkFixture>[0]) => {
  const f = await createLinkFixture(o);
  fixtures.push(f);
  return f;
};

async function client(fx: LinkFixture, o: { trust?: TrustedHubStore; confirm?: (h: HubCandidate) => Promise<boolean>; proofs?: Awaited<ReturnType<LinkFixture['newClient']>> } = {}) {
  const seen: HubCandidate[] = [];
  const identity: Array<{ fingerprint: string; name: string }> = [];
  const t = createBluetoothTransport({
    proofs: o.proofs ?? (await fx.newClient('phone')),
    confirmHub: async (h) => (seen.push(h), o.confirm ? o.confirm(h) : true),
    trustStore: o.trust ?? createMemoryTrustStore(),
    bluetooth: fx.link.bluetooth() as never,
    isSecureContext: true,
  });
  t.onIdentityChanged((i) => identity.push(i));
  await t.start();
  return { t, seen, identity };
}

describe('first contact', () => {
  it('asks the user once with the Hub name, fingerprint and four words, then pins the Hub', async () => {
    const fx = await fixture();
    const trust = createMemoryTrustStore();
    const a = await client(fx, { trust });
    const info = await a.t.chooseHub();
    expect(a.seen).toHaveLength(1);
    expect(a.seen[0]).toMatchObject({ name: fx.settings.displayName, fingerprint: fx.identity.fingerprintText, mode: 'open' });
    expect(a.seen[0]!.words).toEqual(fx.identity.words);
    expect(info.fingerprint).toBe(fx.identity.fingerprintText);
    expect((await trust.list()).map((h) => h.fingerprint)).toEqual([fx.identity.fingerprintText]);
    expect((await trust.get(fx.identity.fingerprintText))!.publicKey).toEqual(fx.identity.publicKey);
  });

  it('does not ask again for a pinned Hub', async () => {
    const fx = await fixture();
    const trust = createMemoryTrustStore();
    const a = await client(fx, { trust });
    await a.t.chooseHub();
    await a.t.disconnectHub(fx.identity.fingerprintText);
    await new Promise((r) => setTimeout(r, 20));
    await a.t.chooseHub();
    expect(a.seen).toHaveLength(1);
  });

  it('a user who says no is not connected and nothing is pinned', async () => {
    const fx = await fixture();
    const trust = createMemoryTrustStore();
    const a = await client(fx, { trust, confirm: async () => false });
    await expect(a.t.chooseHub()).rejects.toMatchObject({ code: 'declined' });
    expect(await trust.list()).toEqual([]);
    expect(fx.peers).toEqual([]);
    expect(a.t.connections()).toEqual([]);
  });

  it('forgetting a Hub removes the pin, so the next contact asks again', async () => {
    const fx = await fixture();
    const trust = createMemoryTrustStore();
    const a = await client(fx, { trust });
    await a.t.chooseHub();
    await a.t.forgetHub(fx.identity.fingerprintText);
    await new Promise((r) => setTimeout(r, 20));
    expect(await trust.list()).toEqual([]);
    await a.t.chooseHub();
    expect(a.seen).toHaveLength(2);
  });
});

describe('a Hub that is not the one you trusted', () => {
  it('a Hub that claims a pinned fingerprint with a different key is refused and the user is told', async () => {
    const real = await fixture();
    const trust = createMemoryTrustStore();
    const a = await client(real, { trust });
    await a.t.chooseHub();
    await a.t.stop();

    const rogue = await fixture();
    await rogue.bridge.setInfo(encodeInfo({ ...rogue.server.info(), fp: real.identity.fingerprintText })); // advertises the trusted fingerprint
    const b = createBluetoothTransport({
      proofs: await rogue.newClient('phone'),
      confirmHub: async () => true,
      trustStore: trust,
      bluetooth: rogue.link.bluetooth() as never,
      isSecureContext: true,
    });
    const changed: string[] = [];
    b.onIdentityChanged((i) => changed.push(i.fingerprint));
    await b.start();
    await expect(b.chooseHub()).rejects.toMatchObject({ code: 'identity-changed' });
    expect(changed).toEqual([real.identity.fingerprintText]);
    expect(rogue.peers).toEqual([]); // it never got as far as proving anything
  });

  it('a different Hub with its own fingerprint is simply a new Hub and is asked about', async () => {
    const one = await fixture();
    const two = await fixture();
    const trust = createMemoryTrustStore();
    const a = await client(one, { trust });
    await a.t.chooseHub();
    const b = await client(two, { trust });
    await b.t.chooseHub();
    expect(b.seen).toHaveLength(1);
    expect((await trust.list()).length).toBe(2);
  });
});

describe('what a person is told', () => {
  it('a Hub from the future (version ranges that do not overlap) says to update, without connecting', async () => {
    const fx = await fixture();
    await fx.bridge.setInfo(encodeInfo({ ...fx.server.info(), v: [2, 3] }));
    const a = await client(fx);
    await expect(a.t.chooseHub()).rejects.toMatchObject({ code: 'update-needed' });
    expect(fx.peers).toEqual([]);
  });

  it('a Hub that does not serve my Spaces says so', async () => {
    const fx = await fixture();
    const other = await createSpaceAccess({ seed: 9, keyByte: 0x33 });
    const a = await client(fx, { proofs: await memberProofs([other], 'stranger') });
    await expect(a.t.chooseHub()).rejects.toMatchObject({ code: 'not-served' });
    expect(a.t.connections()).toEqual([]);
  });

  it('a full Hub says busy with a retry hint, and the status shows it', async () => {
    const fx = await fixture({ settings: { maxClients: 1 } });
    const first = await client(fx);
    await first.t.chooseHub();
    const second = await client(fx);
    const err = await second.t.chooseHub().then(
      () => undefined,
      (e) => e as HubLinkError,
    );
    expect(err).toBeInstanceOf(HubLinkError);
    expect(err).toMatchObject({ code: 'busy' });
    expect(err!.retryMs).toBeGreaterThan(0);
    expect(second.t.status()).toMatchObject({ kind: 'full' });
  });
});
