// T014: semver parsing and range matching (no dependency).
import { describe, expect, it } from 'vitest';
import { compareVersions, parseVersion, satisfies, validateRange } from '../../src/definition/semver';

describe('parseVersion', () => {
  it('parses x.y.z', () => {
    expect(parseVersion('1.2.3')).toEqual([1, 2, 3]);
    expect(parseVersion('0.0.0')).toEqual([0, 0, 0]);
    expect(parseVersion('10.20.30')).toEqual([10, 20, 30]);
  });
  it.each(['1.2', '1.2.3.4', 'v1.2.3', '1.2.3-beta', '01.2.3', '', 'a.b.c', '1.2.-3'])('rejects %j', (v) => {
    expect(() => parseVersion(v)).toThrow(/version/);
  });
});

describe('compareVersions', () => {
  it('orders numerically, not lexically', () => {
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('0.9.9', '1.0.0')).toBeLessThan(0);
  });
});

describe('satisfies', () => {
  it('exact', () => {
    expect(satisfies('1.2.3', '1.2.3')).toBe(true);
    expect(satisfies('1.2.4', '1.2.3')).toBe(false);
  });
  it('caret: same major (or same minor when major is 0, same patch when 0.0)', () => {
    expect(satisfies('1.2.3', '^1.2.3')).toBe(true);
    expect(satisfies('1.9.0', '^1.2.3')).toBe(true);
    expect(satisfies('1.2.2', '^1.2.3')).toBe(false);
    expect(satisfies('2.0.0', '^1.2.3')).toBe(false);
    expect(satisfies('0.2.9', '^0.2.3')).toBe(true);
    expect(satisfies('0.3.0', '^0.2.3')).toBe(false);
    expect(satisfies('0.0.3', '^0.0.3')).toBe(true);
    expect(satisfies('0.0.4', '^0.0.3')).toBe(false);
  });
  it('tilde: same minor', () => {
    expect(satisfies('1.2.9', '~1.2.3')).toBe(true);
    expect(satisfies('1.3.0', '~1.2.3')).toBe(false);
    expect(satisfies('1.2.2', '~1.2.3')).toBe(false);
  });
  it('>=', () => {
    expect(satisfies('1.0.0', '>=1.0.0')).toBe(true);
    expect(satisfies('9.9.9', '>=1.0.0')).toBe(true);
    expect(satisfies('0.9.9', '>=1.0.0')).toBe(false);
  });
  it.each(['', '*', '1.x', '^1', '~1.2', '>1.0.0', '1.0.0 - 2.0.0', '^v1.2.3', '>= 1.0.0'])('rejects range %j', (r) => {
    expect(() => validateRange(r)).toThrow(/range/);
    expect(() => satisfies('1.0.0', r)).toThrow(/range/);
  });
});
