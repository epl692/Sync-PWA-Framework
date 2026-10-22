// T030: shuffling delivery of the same control events always gives the same authority state.
import { describe, it } from 'vitest';
import fc from 'fast-check';
import { Authority } from '../../src/authority/authority';
import { SYS, type ControlEvent, type Role } from '../../src/authority/types';
import { SPACE, WALL, binding, key, resetSeqs } from '../helpers';
import { formatClock } from '@sync/core';

const RUNS = Number(process.env.CONVERGENCE_RUNS ?? 300);
const SEED = process.env.CONVERGENCE_SEED ? Number(process.env.CONVERGENCE_SEED) : undefined;

const USERS = ['A', 'B', 'C', 'D', 'E'];
const roles: Role[] = ['owner', 'editor', 'viewer'];
const SHARE = 'SHAREAAAAAAAAAAAAAAAAAAAA';
const HEX = ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb', 'cccccccccccccccc'];

type Spec = { kind: number; author: number; target: number; role: number; t: number; extra: number };

const specArb = fc.record({
  kind: fc.integer({ min: 0, max: 9 }),
  author: fc.integer({ min: 0, max: USERS.length - 1 }),
  target: fc.integer({ min: 0, max: USERS.length - 1 }),
  role: fc.integer({ min: 0, max: 2 }),
  t: fc.integer({ min: 2, max: 400 }),
  extra: fc.integer({ min: 0, max: 5 }),
});

function build(specs: Spec[]): ControlEvent[] {
  resetSeqs();
  const seqs = new Map<string, number>();
  const mk = (type: string, author: string, t: number, fields: unknown): ControlEvent => {
    const seq = (seqs.get(author) ?? 0) + 1;
    seqs.set(author, seq);
    return {
      id: `${author}:${seq}`,
      type: type as never,
      clock: formatClock(WALL + t, 0, author),
      author,
      seq,
      fields: fields as never,
    };
  };
  const out: ControlEvent[] = [
    mk(SYS.genesis, 'A', 1, { owner: { user: 'A', device: 'A', ...key('A'), binding }, nonce: 'n' }),
  ];
  // everyone gets a device and a base role from A so there is something to fight over
  USERS.slice(1).forEach((u, i) => {
    out.push(mk(SYS.device, 'A', 2 + i, { user: u, device: u, ...key(u), binding }));
    out.push(mk(SYS.member, 'A', 3 + i, { action: 'add', user: u, role: roles[(i + 1) % 3] }));
  });
  for (const s of specs) {
    const author = USERS[s.author]!;
    const target = USERS[s.target]!;
    const role = roles[s.role]!;
    switch (s.kind) {
      case 0:
        out.push(mk(SYS.member, author, s.t, { action: 'role', user: target, role }));
        break;
      case 1:
        out.push(
          mk(SYS.member, author, s.t, { action: 'remove', user: target, cutoff: { [target]: s.extra * 3 } }),
        );
        break;
      case 2:
        out.push(mk(SYS.member, author, s.t, { action: 'add', user: target, role }));
        break;
      case 3:
        out.push(mk(SYS.deviceRevoke, author, s.t, { device: target, cutoff: s.extra }));
        break;
      case 4:
        out.push(
          mk(SYS.device, author, s.t, {
            user: target,
            device: `${target}${s.extra}`,
            ...key(target),
            binding,
          }),
        );
        break;
      case 5:
        out.push(
          mk(SYS.invite, author, s.t, {
            inviteId: `i${s.extra}`,
            role,
            expiresAt: WALL + s.t + 5000,
            maxUses: 1 + (s.extra % 2),
            secretHash: 'h',
            approval: 'required',
          }),
        );
        break;
      case 6:
        out.push(mk(SYS.member, author, s.t, { action: 'add', user: target, role, inviteId: `i${s.extra}` }));
        break;
      case 7:
        out.push(
          mk(SYS.epoch, author, s.t, {
            scope: s.extra % 2 ? SPACE : SHARE,
            epoch: s.extra,
            keyId: HEX[s.extra % 3]!,
          }),
        );
        break;
      case 8:
        out.push(
          mk(SYS.share, author, s.t, {
            shareId: SHARE,
            obj: `o${s.extra % 2}`,
            members: [
              { user: author, role: 'owner' },
              { user: target, role },
            ],
          }),
        );
        break;
      default:
        out.push(
          mk(SYS.shareMember, author, s.t, {
            shareId: SHARE,
            action: s.extra % 3 === 0 ? 'remove' : s.extra % 3 === 1 ? 'add' : 'role',
            user: target,
            role,
          }),
        );
    }
  }
  return out;
}

describe('authority fold order independence (SC-001)', () => {
  it('any delivery order of the same control events gives the same state, and always at least one Owner', () => {
    fc.assert(
      fc.property(fc.array(specArb, { minLength: 1, maxLength: 40 }), fc.integer(), (specs, seed) => {
        const events = build(specs);
        const ref = new Authority(SPACE);
        ref.load(events);
        // a random delivery order
        const order = [...events];
        let s = seed >>> 0;
        for (let i = order.length - 1; i > 0; i--) {
          s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
          const j = s % (i + 1);
          [order[i], order[j]] = [order[j]!, order[i]!];
        }
        const peer = new Authority(SPACE);
        for (const e of order) peer.add(e);
        if (peer.stateDigest() !== ref.stateDigest()) return false;
        // idempotent: re-adding everything changes nothing
        for (const e of order) peer.add(e);
        if (peer.stateDigest() !== ref.stateDigest()) return false;
        return ref.ownerCount() >= 1 && peer.ownerCount() >= 1;
      }),
      { numRuns: RUNS, seed: SEED },
    );
  });
});
