import { describe, expect, it } from 'vitest';
import { HUB_CODE_PREFIX, HubCodeError, encodeHubCode, parseHubCode } from '../../src/hubCodes';

const pub = new Uint8Array(32).fill(7);
const secret = new Uint8Array(32).fill(9);

describe('hub codes', () => {
  it('round-trips a serve code with no secret', () => {
    const text = encodeHubCode({ v: 1, kind: 'serve', space: 'SPACEID', epoch: 3, accessPublic: pub, name: 'Family', createdAt: 5 });
    expect(text.startsWith(HUB_CODE_PREFIX)).toBe(true);
    const c = parseHubCode(text, 10);
    expect(c.kind).toBe('serve');
    expect(c.space).toBe('SPACEID');
    expect(c.epoch).toBe(3);
    expect(c.name).toBe('Family');
    expect(c.accessSecret).toBeUndefined();
    expect(text).not.toContain('accessSecret');
  });

  it('a link code carries the access secret', () => {
    const c = parseHubCode(encodeHubCode({ v: 1, kind: 'link', space: 'S', epoch: 0, accessPublic: pub, accessSecret: secret, createdAt: 1 }));
    expect(c.kind).toBe('link');
    expect(Array.from(c.accessSecret!)).toEqual(Array.from(secret));
  });

  it('rejects junk, unknown versions, wrong lengths and expired codes', () => {
    const bad = (s: string, code: string, now?: number) => {
      try {
        parseHubCode(s, now);
        throw new Error('should have thrown');
      } catch (e) {
        expect((e as HubCodeError).code).toBe(code);
      }
    };
    bad('hello', 'malformed');
    bad('syncserve:2:abcd', 'unsupported-version');
    bad(HUB_CODE_PREFIX + 'not-json', 'malformed');
    const short = encodeHubCode({ v: 1, kind: 'serve', space: 'S', epoch: 1, accessPublic: new Uint8Array(31), createdAt: 1 });
    bad(short, 'bad-length');
    const exp = encodeHubCode({ v: 1, kind: 'serve', space: 'S', epoch: 1, accessPublic: pub, createdAt: 1, expiresAt: 100 });
    bad(exp, 'expired', 200);
    expect(parseHubCode(exp, 50).expiresAt).toBe(100);
  });

  it('a link code without a secret cannot be encoded', () => {
    expect(() => encodeHubCode({ v: 1, kind: 'link', space: 'S', epoch: 0, accessPublic: pub, createdAt: 1 })).toThrow();
  });
});
