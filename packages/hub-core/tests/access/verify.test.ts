// Spec 005 T032: serve-code import and membership verification on the Hub, using proofs produced by @sync/spaces.
import { describe, expect, it } from 'vitest';
import { base32 } from '@sync/core';
import { deriveHubAccess, encodeHubCode, hubAuthMessage, proveHubChallenge } from '@sync/spaces';
import { ServeCodeError, applyServeCode, parseServeCode, pruneExpiredKeys, DAY_MS } from '../../src/access/codes';
import { authMessage, spaceIdBytes, verifyMembership } from '../../src/access/verify';

const spaceRaw = Uint8Array.from({ length: 16 }, (_, i) => 0xa0 + i);
const SPACE = base32(spaceRaw);
const epochKey = (n: number) => new Uint8Array(32).fill(n);
const fp = new Uint8Array(32).fill(0x55);
const nc = new Uint8Array(16).fill(0x11);
const nh = new Uint8Array(16).fill(0x22);
const NOW = 1_800_000_000_000;
const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function codeFor(epoch: number, over: { link?: boolean; expiresAt?: number } = {}) {
  const k = await deriveHubAccess(epochKey(epoch + 1), spaceRaw, epoch);
  const text = encodeHubCode({ v: 1, kind: over.link ? 'link' : 'serve', space: SPACE, epoch, accessPublic: k.publicRaw, ...(over.link ? { accessSecret: k.seed } : {}), createdAt: NOW, ...(over.expiresAt ? { expiresAt: over.expiresAt } : {}) });
  return { k, text };
}
async function proof(epoch: number, spaceBytes = spaceRaw, nonceC = nc) {
  const k = await deriveHubAccess(epochKey(epoch + 1), spaceRaw, epoch);
  return b64u(await proveHubChallenge(k, hubAuthMessage({ hubFingerprint: fp, nc: nonceC, nh, space: spaceBytes, epoch })));
}

describe('space id bytes and message', () => {
  it('decodes base32 Space IDs and matches the spaces package message byte for byte', () => {
    expect(Array.from(spaceIdBytes(SPACE)!)).toEqual(Array.from(spaceRaw));
    expect(spaceIdBytes('short')).toBeNull();
    expect(Array.from(authMessage({ hubFingerprint: fp, nc, nh, space: spaceRaw, epoch: 4 }))).toEqual(
      Array.from(hubAuthMessage({ hubFingerprint: fp, nc, nh, space: spaceRaw, epoch: 4 })),
    );
  });
});

describe('parseServeCode (accepts what @sync/spaces exports)', () => {
  it('parses serve and link codes', async () => {
    const s = parseServeCode((await codeFor(2)).text, NOW);
    expect(s).toMatchObject({ kind: 'serve', space: SPACE, epoch: 2 });
    expect(s.accessSecret).toBeUndefined();
    const l = parseServeCode((await codeFor(2, { link: true })).text, NOW);
    expect(l.kind).toBe('link');
    expect(l.accessSecret).toHaveLength(32);
  });
  it('rejects junk, unknown versions, bad lengths, bad Space IDs and expired codes', async () => {
    const code = (t: string) => {
      try {
        parseServeCode(t, NOW);
      } catch (e) {
        return (e as ServeCodeError).code;
      }
      return 'ok';
    };
    expect(code('hello')).toBe('malformed');
    expect(code('syncserve:9:abc')).toBe('unsupported-version');
    expect(code('syncserve:1:@@@')).toBe('malformed');
    const mk = (o: Record<string, unknown>) => 'syncserve:1:' + b64u(new TextEncoder().encode(JSON.stringify({ v: 1, kind: 'serve', space: SPACE, epoch: 1, accessPublic: b64u(new Uint8Array(32)), createdAt: 1, ...o })));
    expect(code(mk({}))).toBe('ok');
    expect(code(mk({ accessPublic: b64u(new Uint8Array(31)) }))).toBe('bad-length');
    expect(code(mk({ space: 'nope' }))).toBe('malformed');
    expect(code(mk({ kind: 'link' }))).toBe('bad-length');
    expect(code(mk({ expiresAt: NOW - 1 }))).toBe('expired');
  });
});

describe('applyServeCode', () => {
  it('registers a key, and a newer epoch retires the older key after the retention period', async () => {
    const c1 = parseServeCode((await codeFor(1)).text, NOW);
    const r1 = applyServeCode(undefined, c1, NOW, 14);
    expect(r1.accessKeys).toHaveLength(1);
    expect(r1.accessKeys[0]!.expiresAt).toBeUndefined();
    const c2 = parseServeCode((await codeFor(2)).text, NOW + 1000);
    const r2 = applyServeCode(r1, c2, NOW + 1000, 14);
    expect(r2.accessKeys.map((k) => k.epoch)).toEqual([2, 1]);
    expect(r2.accessKeys.find((k) => k.epoch === 1)!.expiresAt).toBe(NOW + 1000 + 14 * DAY_MS);
    expect(r2.accessKeys.find((k) => k.epoch === 2)!.expiresAt).toBeUndefined();
    expect(pruneExpiredKeys(r2, NOW + 15 * DAY_MS + 1000)).toBe(true);
    expect(r2.accessKeys.map((k) => k.epoch)).toEqual([2]);
    expect(pruneExpiredKeys(r2, NOW + 99 * DAY_MS)).toBe(false);
  });
  it('a serve code never removes the secret of a link code already held', async () => {
    const link = applyServeCode(undefined, parseServeCode((await codeFor(1, { link: true })).text, NOW), NOW, 14);
    expect(link.accessSecret).toHaveLength(32);
    const again = applyServeCode(link, parseServeCode((await codeFor(1)).text, NOW), NOW, 14);
    expect(again.accessSecret).toHaveLength(32);
  });
});

describe('verifyMembership', () => {
  const record = async (epochs: number[], expired: number[] = []) => {
    let rec = undefined as ReturnType<typeof applyServeCode> | undefined;
    for (const e of epochs) rec = applyServeCode(rec, parseServeCode((await codeFor(e)).text, NOW), NOW, 14);
    for (const k of rec!.accessKeys) if (expired.includes(k.epoch)) k.expiresAt = NOW - 1;
    return rec!;
  };
  const run = (records: unknown[], entries: Array<{ space: string; epoch: number; sig: string }>) =>
    verifyMembership({ records: records as never, entries, hubFingerprint: fp, nc, nh, now: NOW });

  it('accepts a good proof', async () => {
    expect(await run([await record([4])], [{ space: SPACE, epoch: 4, sig: await proof(4) }])).toEqual({ accepted: [SPACE], rejected: [] });
  });
  it('unknown Space and bad proof are indistinguishable', async () => {
    const rec = await record([4]);
    const other = base32(Uint8Array.from({ length: 16 }, (_, i) => i));
    const a = await run([rec], [{ space: other, epoch: 4, sig: await proof(4) }]);
    const b = await run([rec], [{ space: SPACE, epoch: 4, sig: await proof(4, spaceRaw, new Uint8Array(16).fill(9)) }]);
    expect(a).toEqual({ accepted: [], rejected: [other] });
    expect(b).toEqual({ accepted: [], rejected: [SPACE] });
  });
  it('wrong epoch, expired key, malformed signature and bad epoch are rejected', async () => {
    const rec = await record([4, 3], [3]);
    expect((await run([rec], [{ space: SPACE, epoch: 5, sig: await proof(5) }])).accepted).toEqual([]);
    expect((await run([rec], [{ space: SPACE, epoch: 3, sig: await proof(3) }])).accepted).toEqual([]); // expired
    expect((await run([rec], [{ space: SPACE, epoch: 4, sig: 'not base64 !!' }])).accepted).toEqual([]);
    expect((await run([rec], [{ space: SPACE, epoch: -1, sig: await proof(4) }])).accepted).toEqual([]);
    expect((await run([rec], [{ space: SPACE, epoch: 4, sig: await proof(4) }])).accepted).toEqual([SPACE]);
  });
  it('an older epoch still within its grace period is accepted', async () => {
    const rec = await record([4, 3]);
    expect((await run([rec], [{ space: SPACE, epoch: 3, sig: await proof(3) }])).accepted).toEqual([SPACE]);
  });
  it('considers at most 2 entries per Space', async () => {
    const rec = await record([4]);
    const bad = { space: SPACE, epoch: 1, sig: await proof(1) };
    expect((await run([rec], [bad, bad, { space: SPACE, epoch: 4, sig: await proof(4) }])).accepted).toEqual([]);
    expect((await run([rec], [bad, { space: SPACE, epoch: 4, sig: await proof(4) }])).accepted).toEqual([SPACE]);
  });
});
