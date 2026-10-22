// T036: the contract suite itself must fail for providers that break the contract.
import { describe, expect, it } from 'vitest';
import type { IdentityProvider } from '@sync/spaces';
import { createStubIdentityProvider, runIdentityProviderChecks } from '../src/spaces';

type Tweak = (p: IdentityProvider, state: { host?: any }) => IdentityProvider;

function broken(tweak: Tweak) {
  return () => {
    const state: { host?: any } = {};
    const base = createStubIdentityProvider();
    const init = base.init.bind(base);
    base.init = async (h) => {
      state.host = h;
      return init(h);
    };
    return tweak(base, state);
  };
}

const failures = async (make: () => IdentityProvider) =>
  (await runIdentityProviderChecks(make)).failed.map((f) => f.name);

describe('the contract suite catches broken providers', () => {
  it('passes a correct provider', async () => {
    const r = await runIdentityProviderChecks(createStubIdentityProvider);
    expect(r.failed).toEqual([]);
    expect(r.passed.length).toBeGreaterThanOrEqual(15);
  });

  it('flags a verifyBinding that reads the clock or randomness (impure)', async () => {
    const f = await failures(
      broken((p, s) => ({
        ...p,
        verifyBinding: async (...a) => (
          s.host.now(),
          s.host.random(1),
          createStubIdentityProvider().verifyBinding(...a)
        ),
      })),
    );
    expect(f).toContain(
      'verifyBinding is deterministic and free of side effects (no clock, randomness or channel)',
    );
  });

  it('flags a verifyBinding that accepts any binding', async () => {
    const f = await failures(broken((p) => ({ ...p, verifyBinding: async () => true })));
    expect(f).toContain('verifyBinding rejects another user, another device, and a tampered proof');
  });

  it('flags a verifyBinding that throws on garbage', async () => {
    const f = await failures(
      broken((p) => ({
        ...p,
        verifyBinding: async (u, d, b, k) =>
          b.proof.length > 100 ? Promise.reject(new Error('boom')) : p.verifyBinding(u, d, b, k),
      })),
    );
    expect(f).toContain('verifyBinding never throws on garbage input');
  });

  it('flags an invite that skips validation of its spec', async () => {
    const f = await failures(
      broken((p, s) => ({
        ...p,
        createInvite: async (sess, spec) =>
          p.createInvite(sess, {
            ...spec,
            maxUses: Math.max(1, spec.maxUses),
            expiresAt: Math.max(spec.expiresAt, s.host.now() + 1000),
          }),
      })),
    );
    expect(f).toContain(
      'createInvite validates its spec: uses >= 1, expiry in the future and within 30 days',
    );
  });

  it('flags an accepting side that ignores a declined approval', async () => {
    const f = await failures(
      broken((p, s) => {
        const orig = s;
        void orig;
        return { ...p, init: async (h) => p.init({ ...h, approve: async () => true }) };
      }),
    );
    expect(f).toContain('a declined join is denied and nothing is admitted');
  });

  it('flags a provider that forgets replay protection', async () => {
    const f = await failures(
      broken((p) => ({
        ...p,
        init: async (h) => {
          const store = new Map<string, { secret: Uint8Array; seenNonces: string[] }>();
          return p.init({
            ...h,
            secrets: {
              get: async (id) => (store.has(id) ? { ...store.get(id)!, seenNonces: [] } : undefined), // forgets every nonce it has seen
              put: async (id, v) => void store.set(id, v),
            },
          });
        },
      })),
    );
    expect(f).toContain('a replayed or tampered join request never admits anyone twice');
  });

  it('flags a provider whose linked device ends up with another user', async () => {
    const f = await failures(
      broken((p) => ({
        ...p,
        completeLink: async (code) => ({ ...(await p.completeLink(code)), user: 'someone-else' }),
      })),
    );
    expect(f).toContain('linking a device binds it to the same user and delivers the keys');
  });
});
