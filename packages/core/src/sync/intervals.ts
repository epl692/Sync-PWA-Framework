/** Sorted, non-overlapping, non-adjacent inclusive integer ranges. All functions are pure. */
export type Interval = [number, number];

export function addRange(iv: readonly Interval[], lo: number, hi: number): Interval[] {
  const out: Interval[] = [];
  let nlo = lo;
  let nhi = hi;
  let placed = false;
  for (const [a, b] of iv) {
    if (b + 1 < nlo) out.push([a, b]);
    else if (a - 1 > nhi) {
      if (!placed) {
        out.push([nlo, nhi]);
        placed = true;
      }
      out.push([a, b]);
    } else {
      nlo = Math.min(nlo, a);
      nhi = Math.max(nhi, b);
    }
  }
  if (!placed) out.push([nlo, nhi]);
  return out;
}

export function addValue(iv: readonly Interval[], n: number): Interval[] {
  return addRange(iv, n, n);
}

export function containsValue(iv: readonly Interval[], n: number): boolean {
  let lo = 0;
  let hi = iv.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [a, b] = iv[mid]!;
    if (n < a) hi = mid - 1;
    else if (n > b) lo = mid + 1;
    else return true;
  }
  return false;
}

export function countValues(iv: readonly Interval[]): number {
  return iv.reduce((n, [a, b]) => n + (b - a + 1), 0);
}

export function mergeIntervals(a: readonly Interval[], b: readonly Interval[]): Interval[] {
  let out = a.map(([x, y]): Interval => [x, y]);
  for (const [lo, hi] of b) out = addRange(out, lo, hi);
  return out;
}

/** Ranges present in `a` that are missing from `b`. */
export function diffIntervals(a: readonly Interval[], b: readonly Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const [lo, hi] of a) {
    let cur = lo;
    for (const [x, y] of b) {
      if (y < cur) continue;
      if (x > hi) break;
      if (x > cur) out.push([cur, x - 1]);
      cur = y + 1;
      if (cur > hi) break;
    }
    if (cur <= hi) out.push([cur, hi]);
  }
  return out;
}
