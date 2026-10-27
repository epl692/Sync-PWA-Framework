/** Minimal semver: exact `x.y.z` versions and the ranges `x.y.z`, `^x.y.z`, `~x.y.z`, `>=x.y.z`. No prerelease tags. */

export type Version = [number, number, number];

const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function parseVersion(v: string): Version {
  const m = typeof v === 'string' ? VERSION_RE.exec(v) : null;
  if (!m) throw new Error(`invalid version ${JSON.stringify(v)} (expected x.y.z)`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
  return 0;
}

type Range = { op: '=' | '^' | '~' | '>='; v: Version };

function parseRange(r: string): Range {
  const m = typeof r === 'string' ? /^(\^|~|>=)?(.+)$/.exec(r) : null;
  const bad = () => new Error(`invalid range ${JSON.stringify(r)} (use x.y.z, ^x.y.z, ~x.y.z or >=x.y.z)`);
  if (!m) throw bad();
  try {
    return { op: (m[1] as Range['op'] | undefined) ?? '=', v: parseVersion(m[2]!) };
  } catch {
    throw bad();
  }
}

export function validateRange(r: string): void {
  parseRange(r);
}

export function satisfies(version: string, range: string): boolean {
  const { op, v } = parseRange(range);
  const x = parseVersion(version);
  const cmp = compareVersions(version, v.join('.'));
  switch (op) {
    case '=':
      return cmp === 0;
    case '>=':
      return cmp >= 0;
    case '~':
      return cmp >= 0 && x[0] === v[0] && x[1] === v[1];
    case '^':
      if (cmp < 0) return false;
      if (v[0] > 0) return x[0] === v[0];
      if (v[1] > 0) return x[0] === 0 && x[1] === v[1];
      return x[0] === 0 && x[1] === 0 && x[2] === v[2];
  }
}
