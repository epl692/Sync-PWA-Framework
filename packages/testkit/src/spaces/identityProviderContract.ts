/**
 * The reusable Identity Provider contract suite (Principle VIII, FR-013, SC-005).
 *
 *   identityProviderContract('my provider', () => createMyProvider());
 *
 * The checks are plain async functions so they can also be run directly (`runIdentityProviderChecks`),
 * which is how the suite itself is tested against deliberately broken providers.
 */

import { describe, expect, it } from 'vitest';
import {
  JoinDeniedError,
  type DeviceBinding,
  type DevicePublic,
  type IdentityProvider,
  type InviteSpec,
  type JoinRequestView,
  type UserSession,
} from '@sync/spaces';
import { FakeChannelNet, FakeHost, newInviteSpace } from './fakeHost';

export type ProviderFactory = () => IdentityProvider;

interface Node {
  host: FakeHost;
  provider: IdentityProvider;
  session: UserSession;
}

async function node(name: string, net: FakeChannelNet, make: ProviderFactory): Promise<Node> {
  const host = await FakeHost.create(name, net);
  const provider = make();
  await provider.init(host.host);
  const session = await provider.createUser({ displayName: name });
  host.session = session;
  return { host, provider, session };
}

const DAY = 24 * 60 * 60 * 1000;

async function world(make: ProviderFactory) {
  const net = new FakeChannelNet();
  const owner = await node('owner', net, make);
  const joiner = await node('joiner', net, make);
  const space = newInviteSpace();
  const spec = (over: Partial<InviteSpec> = {}): InviteSpec => ({ space, role: 'editor', expiresAt: owner.host.clockMs + DAY, maxUses: 1, approval: 'required', ...over });
  return { net, owner, joiner, space, spec };
}

const publicOf = (n: Node): DevicePublic => n.session.device;
const flip = (b: DeviceBinding): DeviceBinding => ({ kind: b.kind, proof: b.proof.map((x, i) => (i === b.proof.length - 1 ? x ^ 1 : x)) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const denial = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'accepted';
  } catch (e) {
    return e instanceof JoinDeniedError ? e.reason : `error: ${(e as Error).message}`;
  }
};

export interface Check {
  name: string;
  run(make: ProviderFactory): Promise<void>;
}

export const identityProviderChecks: Check[] = [
  {
    name: 'createUser binds the install device to a user',
    async run(make) {
      const { owner } = await world(make);
      expect(owner.session.user).toBeTruthy();
      expect(owner.session.device.deviceId).toBe(owner.host.device.deviceId);
      expect(owner.session.displayName).toBe('owner');
    },
  },
  {
    name: 'verifyBinding accepts evidence the provider issued for the first device and for a linked device',
    async run(make) {
      const { owner, joiner } = await world(make);
      const own = await owner.provider.issueBinding(owner.session, publicOf(owner));
      expect(await owner.provider.verifyBinding(owner.session.user, publicOf(owner), own, [])).toBe(true);
      expect(owner.provider.bindingKinds).toContain(own.kind);
      const linked = await owner.provider.issueBinding(owner.session, publicOf(joiner));
      expect(await owner.provider.verifyBinding(owner.session.user, publicOf(joiner), linked, [publicOf(owner)])).toBe(true);
      // a different provider instance (another device) reaches the same verdict: verification needs no private state
      expect(await joiner.provider.verifyBinding(owner.session.user, publicOf(joiner), linked, [publicOf(owner)])).toBe(true);
    },
  },
  {
    name: 'verifyBinding rejects another user, another device, and a tampered proof',
    async run(make) {
      const { owner, joiner } = await world(make);
      const b = await owner.provider.issueBinding(owner.session, publicOf(owner));
      expect(await owner.provider.verifyBinding('someone-else', publicOf(owner), b, [])).toBe(false);
      expect(await owner.provider.verifyBinding(owner.session.user, publicOf(joiner), b, [])).toBe(false);
      expect(await owner.provider.verifyBinding(owner.session.user, publicOf(owner), flip(b), [])).toBe(false);
    },
  },
  {
    name: 'verifyBinding is deterministic and free of side effects (no clock, randomness or channel)',
    async run(make) {
      const { owner } = await world(make);
      const d = publicOf(owner);
      const b = await owner.provider.issueBinding(owner.session, d);
      owner.host.resetTouched();
      const results: boolean[] = [];
      for (let i = 0; i < 5; i++) results.push(await owner.provider.verifyBinding(owner.session.user, d, i % 2 ? flip(b) : b, []));
      expect(results).toEqual([true, false, true, false, true]);
      expect(owner.host.touched).toEqual({ now: 0, random: 0, channel: 0 });
    },
  },
  {
    name: 'verifyBinding never throws on garbage input',
    async run(make) {
      const { owner } = await world(make);
      const d = publicOf(owner);
      const junk: DeviceBinding[] = [
        { kind: '', proof: new Uint8Array() },
        { kind: 'no-such-kind/9', proof: new Uint8Array(64).fill(7) },
        { kind: owner.provider.bindingKinds[0]!, proof: new Uint8Array() },
        { kind: owner.provider.bindingKinds[0]!, proof: crypto.getRandomValues(new Uint8Array(300)) },
      ];
      for (const b of junk) expect(await owner.provider.verifyBinding(owner.session.user, d, b, [d])).toBe(false);
    },
  },
  {
    name: 'createInvite validates its spec: uses >= 1, expiry in the future and within 30 days',
    async run(make) {
      const { owner, spec } = await world(make);
      const now = owner.host.clockMs;
      for (const bad of [spec({ maxUses: 0 }), spec({ expiresAt: now }), spec({ expiresAt: now - 1000 }), spec({ expiresAt: now + 31 * DAY })]) {
        await expect(owner.provider.createInvite(owner.session, bad)).rejects.toThrow();
      }
      expect(owner.host.calls.registerInvite).toHaveLength(0);
    },
  },
  {
    name: 'createInvite registers the invite with a hash of its secret, never the secret',
    async run(make) {
      const { owner, spec, space } = await world(make);
      const art = await owner.provider.createInvite(owner.session, spec({ maxUses: 3 }));
      expect(art.inviteId).toBeTruthy();
      expect(art.qrPayload.length).toBeGreaterThan(0);
      expect(art.expiresAt).toBe(owner.host.clockMs + DAY);
      expect(owner.host.calls.registerInvite).toHaveLength(1);
      const r = owner.host.calls.registerInvite[0]!;
      expect(r).toMatchObject({ space, inviteId: art.inviteId, role: 'editor', maxUses: 3, approval: 'required' });
      expect(r.secretHash).toHaveLength(32);
      // the secret stays on the creating device; what the Space log gets is its SHA-256
      const stored = owner.host.secretStore.get(art.inviteId);
      expect(stored).toBeDefined();
      expect(new Uint8Array(await crypto.subtle.digest('SHA-256', stored!.secret as BufferSource))).toEqual(r.secretHash);
      expect(JSON.stringify(Array.from(r.secretHash))).not.toBe(JSON.stringify(Array.from(stored!.secret)));
      expect(JSON.stringify({ ...r, secretHash: undefined })).not.toContain(JSON.stringify(Array.from(stored!.secret)));
    },
  },
  {
    name: 'a valid invite is accepted after approval, and the joiner receives the grant',
    async run(make) {
      const { owner, joiner, spec, space } = await world(make);
      const art = await owner.provider.createInvite(owner.session, spec());
      const res = await joiner.provider.acceptInvite(joiner.session, art.url);
      expect(res).toEqual({ space, role: 'editor' });
      expect(owner.host.calls.approve).toHaveLength(1);
      const view: JoinRequestView = owner.host.calls.approve[0]!;
      expect(view).toMatchObject({ space, inviteId: art.inviteId, role: 'editor' });
      expect(view.sas).toBeTruthy();
      expect(owner.host.calls.admit).toHaveLength(1);
      const req = owner.host.calls.admit[0]!;
      expect(req.user).toBe(joiner.session.user);
      expect(req.device.deviceId).toBe(joiner.host.device.deviceId);
      expect(await owner.provider.verifyBinding(req.user, req.device, req.binding, [])).toBe(true);
      expect(joiner.host.calls.completeJoin).toHaveLength(1);
      expect(joiner.host.calls.completeJoin[0]).toMatchObject({ space, role: 'editor' });
    },
  },
  {
    name: 'automatic approval skips the approval prompt',
    async run(make) {
      const { owner, joiner, spec } = await world(make);
      const art = await owner.provider.createInvite(owner.session, spec({ approval: 'auto' }));
      await joiner.provider.acceptInvite(joiner.session, art.url);
      expect(owner.host.calls.approve).toHaveLength(0);
      expect(owner.host.calls.admit).toHaveLength(1);
    },
  },
  {
    name: 'a declined join is denied and nothing is admitted',
    async run(make) {
      const { owner, joiner, spec } = await world(make);
      owner.host.approveWith = () => false;
      const art = await owner.provider.createInvite(owner.session, spec());
      expect(await denial(joiner.provider.acceptInvite(joiner.session, art.url))).toBe('declined');
      expect(owner.host.calls.admit).toHaveLength(0);
      expect(joiner.host.calls.completeJoin).toHaveLength(0);
    },
  },
  {
    name: 'expired, revoked and unknown invites are denied and nothing is admitted',
    async run(make) {
      const { owner, joiner, spec } = await world(make);
      const expired = await owner.provider.createInvite(owner.session, spec());
      owner.host.clockMs += 2 * DAY;
      expect(await denial(joiner.provider.acceptInvite(joiner.session, expired.url))).toBe('expired');
      owner.host.clockMs -= 2 * DAY;
      const revoked = await owner.provider.createInvite(owner.session, spec());
      await owner.provider.revokeInvite(owner.session, revoked.inviteId ? spec().space : '', revoked.inviteId);
      expect(owner.host.calls.revokeInviteRecord).toHaveLength(1);
      expect(await denial(joiner.provider.acceptInvite(joiner.session, revoked.url))).toBe('revoked');
      const lost = await owner.provider.createInvite(owner.session, spec());
      owner.host.invites.delete(lost.inviteId);
      expect(await denial(joiner.provider.acceptInvite(joiner.session, lost.url))).toBe('unknown');
      expect(owner.host.calls.admit).toHaveLength(0);
    },
  },
  {
    name: 'a single-use invite admits one joiner only',
    async run(make) {
      const w = await world(make);
      const second = await node('second', w.net, make);
      const art = await w.owner.provider.createInvite(w.owner.session, w.spec({ approval: 'auto' }));
      expect(await denial(w.joiner.provider.acceptInvite(w.joiner.session, art.url))).toBe('accepted');
      expect(await denial(second.provider.acceptInvite(second.session, art.url))).toBe('used-up');
      expect(w.owner.host.calls.admit).toHaveLength(1);
    },
  },
  {
    name: 'a replayed or tampered join request never admits anyone twice',
    async run(make) {
      const { net, owner, joiner, spec } = await world(make);
      const art = await owner.provider.createInvite(owner.session, spec({ maxUses: 5, approval: 'auto' }));
      await joiner.provider.acceptInvite(joiner.session, art.url);
      expect(owner.host.calls.admit).toHaveLength(1);
      const request = net.log.find((d) => d.from === 'joiner' && d.to === 'owner')!;
      net.deliver({ from: 'joiner', to: 'owner', payload: request.payload }); // replay
      const tampered = request.payload.slice();
      tampered[tampered.length - 1]! ^= 1;
      net.deliver({ from: 'joiner', to: 'owner', payload: tampered });
      await sleep(80);
      expect(owner.host.calls.admit).toHaveLength(1);
    },
  },
  {
    name: 'accepting times out when no inviter is reachable',
    async run(make) {
      const { owner, joiner, spec, net } = await world(make);
      const art = await owner.provider.createInvite(owner.session, spec());
      net.filter = () => null; // the network eats everything
      expect(await denial(joiner.provider.acceptInvite(joiner.session, art.url, { timeoutMs: 100 }))).toBe('timeout');
    },
  },
  {
    name: 'linking a device binds it to the same user and delivers the keys',
    async run(make) {
      const { owner, joiner } = await world(make);
      const { code, done } = await owner.provider.beginLink(owner.session);
      const session = await joiner.provider.completeLink(code);
      expect(session.user).toBe(owner.session.user);
      expect(session.device.deviceId).toBe(joiner.host.device.deviceId);
      expect((await done).device).toBe(joiner.host.device.deviceId);
      expect(owner.host.calls.linkNewDevice).toHaveLength(1);
      const { device, binding } = owner.host.calls.linkNewDevice[0]!;
      expect(device.deviceId).toBe(joiner.host.device.deviceId);
      expect(await owner.provider.verifyBinding(owner.session.user, device, binding, [publicOf(owner)])).toBe(true);
      expect(joiner.host.calls.completeLink).toHaveLength(1);
      expect(joiner.host.calls.completeLink[0]!.user).toBe(owner.session.user);
    },
  },
  {
    name: 'a wrong link code is refused and links nothing',
    async run(make) {
      const { owner, joiner } = await world(make);
      await owner.provider.beginLink(owner.session);
      await expect(joiner.provider.completeLink('not-a-link-code')).rejects.toThrow();
      expect(owner.host.calls.linkNewDevice).toHaveLength(0);
      expect(joiner.host.calls.completeLink).toHaveLength(0);
    },
  },
];

/** Run every check against a provider factory and report which ones failed. Used to test the suite itself. */
export async function runIdentityProviderChecks(make: ProviderFactory): Promise<{ passed: string[]; failed: Array<{ name: string; error: string }> }> {
  const passed: string[] = [];
  const failed: Array<{ name: string; error: string }> = [];
  for (const c of identityProviderChecks) {
    try {
      await c.run(make);
      passed.push(c.name);
    } catch (e) {
      failed.push({ name: c.name, error: (e as Error).message.split('\n')[0]! });
    }
  }
  return { passed, failed };
}

/** Register the suite for a provider. Call from a test file. */
export function identityProviderContract(name: string, make: ProviderFactory): void {
  describe(`Identity Provider contract: ${name}`, () => {
    for (const c of identityProviderChecks) it(c.name, () => c.run(make), 20_000);
  });
}
