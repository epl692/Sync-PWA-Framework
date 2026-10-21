import { describe, expect, it } from 'vitest';
import { addRange, addValue, containsValue, countValues, diffIntervals, mergeIntervals, type Interval } from '../../src/sync/intervals';

describe('intervals', () => {
  it('adds values and merges adjacent ranges', () => {
    let iv: Interval[] = [];
    for (const n of [5, 3, 4, 1, 9, 10]) iv = addValue(iv, n);
    expect(iv).toEqual([[1, 1], [3, 5], [9, 10]]);
  });

  it('is idempotent and does not mutate its input', () => {
    const a: Interval[] = [[1, 3]];
    const b = addValue(a, 2);
    expect(b).toEqual([[1, 3]]);
    expect(a).toEqual([[1, 3]]);
  });

  it('addRange merges overlapping and touching ranges', () => {
    expect(addRange([[1, 2], [5, 6], [10, 12]], 3, 9)).toEqual([[1, 12]]);
    expect(addRange([[1, 2]], 4, 5)).toEqual([[1, 2], [4, 5]]);
  });

  it('contains and counts', () => {
    const iv: Interval[] = [[1, 3], [7, 7]];
    expect([0, 1, 3, 4, 7, 8].map((n) => containsValue(iv, n))).toEqual([false, true, true, false, true, false]);
    expect(countValues(iv)).toBe(4);
  });

  it('diff returns what a has that b lacks', () => {
    expect(diffIntervals([[1, 10]], [[3, 4], [8, 20]])).toEqual([[1, 2], [5, 7]]);
    expect(diffIntervals([[1, 3]], [[1, 3]])).toEqual([]);
    expect(diffIntervals([[1, 3]], [])).toEqual([[1, 3]]);
    expect(diffIntervals([], [[1, 3]])).toEqual([]);
  });

  it('mergeIntervals unions two sets', () => {
    expect(mergeIntervals([[1, 2], [8, 9]], [[3, 4], [9, 12]])).toEqual([[1, 4], [8, 12]]);
  });

  it('treats compacted-covered ranges like any other held range', () => {
    const held = addRange([[1, 5]], 6, 500);
    expect(containsValue(held, 250)).toBe(true);
    expect(diffIntervals([[1, 600]], held)).toEqual([[501, 600]]);
  });
});
