/** Test helpers: synthetic control events for the pure authority fold (no crypto involved). */
import { formatClock } from '@sync/core';
import { Authority } from '../src/authority/authority';
import { SYS, type ControlEvent, type ControlFields, type Role, type SysType } from '../src/authority/types';

export const SPACE = 'SPACEAAAAAAAAAAAAAAAAAAAAA';
export const WALL = 1_700_000_000_000;
export const DAY = 24 * 60 * 60 * 1000;

const seqs = new Map<string, number>();
export function resetSeqs(): void {
  seqs.clear();
}

/** An event authored by `author` (a device ID) at wall time `WALL + t`. */
export function ev<T extends SysType>(
  type: T,
  author: string,
  t: number,
  fields: ControlFields[T],
  seq?: number,
): ControlEvent<T> {
  const s = seq ?? (seqs.get(author) ?? 0) + 1;
  seqs.set(author, s);
  return { id: `${author}:${s}`, type, clock: formatClock(WALL + t, 0, author), author, seq: s, fields };
}

export const key = (d: string) => ({ signPub: `sign-${d}`, agreePub: `agree-${d}` });
export const binding = { kind: 'test', proof: '' };

export const genesis = (dev = 'A', t = 1) =>
  ev(SYS.genesis, dev, t, { owner: { user: dev, device: dev, ...key(dev), binding }, nonce: 'n' });
export const device = (author: string, t: number, user: string, dev: string) =>
  ev(SYS.device, author, t, { user, device: dev, ...key(dev), binding });
export const addMember = (
  author: string,
  t: number,
  user: string,
  role: Role,
  extra: { inviteId?: string } = {},
) => ev(SYS.member, author, t, { action: 'add', user, role, ...extra });
export const setRole = (author: string, t: number, user: string, role: Role) =>
  ev(SYS.member, author, t, { action: 'role', user, role });
export const removeMember = (author: string, t: number, user: string, cutoff: Record<string, number> = {}) =>
  ev(SYS.member, author, t, { action: 'remove', user, cutoff });
export const invite = (
  author: string,
  t: number,
  inviteId: string,
  role: Role,
  over: Partial<ControlFields[typeof SYS.invite]> = {},
) =>
  ev(SYS.invite, author, t, {
    inviteId,
    role,
    expiresAt: WALL + t + DAY,
    maxUses: 1,
    secretHash: 'h',
    approval: 'required',
    ...over,
  });
export const epoch = (author: string, t: number, scope: string, n: number, keyId: string) =>
  ev(SYS.epoch, author, t, { scope, epoch: n, keyId });

/** A Space where device A (user A) is Owner, and B (Editor), C (Viewer) and D (Editor) joined as one-device users. */
export function basicSpace(): { auth: Authority; events: ControlEvent[] } {
  resetSeqs();
  const events: ControlEvent[] = [
    genesis('A', 1),
    device('A', 2, 'B', 'B'),
    addMember('A', 3, 'B', 'editor'),
    device('A', 4, 'C', 'C'),
    addMember('A', 5, 'C', 'viewer'),
    device('A', 6, 'D', 'D'),
    addMember('A', 7, 'D', 'editor'),
  ];
  const auth = new Authority(SPACE);
  for (const e of events) auth.add(e);
  return { auth, events };
}

/** The HLC string for device `dev` at wall time `WALL + t`. */
export const clockAt = (t: number, dev: string, counter = 0) => formatClock(WALL + t, counter, dev);
