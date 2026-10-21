// T028: every rule of contracts/authority-rules.md on the pure fold.
import { describe, expect, it } from 'vitest';
import { Authority } from '../../src/authority/authority';
import { SYS } from '../../src/authority/types';
import { DAY, SPACE, WALL, addMember, clockAt, basicSpace, binding, device, epoch, ev, genesis, invite, key, removeMember, resetSeqs, setRole } from '../helpers';

const inertReasons = (a: Authority) => a.state.inert.map((i) => `${i.type.slice(5)}:${i.reason}`);

describe('genesis', () => {
  it('makes its author the first Owner with the first device', () => {
    resetSeqs();
    const a = new Authority(SPACE);
    a.add(genesis('A'));
    expect(a.currentRole('A')).toBe('owner');
    expect(a.device('A')!.signPub).toBe('sign-A');
    expect(a.genesis()!.user).toBe('A');
  });

  it('a second genesis, a genesis by someone else, and events before genesis are inert', () => {
    resetSeqs();
    const a = new Authority(SPACE);
    a.add(device('A', 1, 'B', 'B')); // before any genesis
    a.add(genesis('A', 2));
    a.add(genesis('X', 3));
    a.add(ev(SYS.genesis, 'Y', 4, { owner: { user: 'Z', device: 'Z', ...key('Z'), binding }, nonce: 'n' })); // author != owner.device
    expect(inertReasons(a)).toEqual(['device:no-genesis', 'genesis:duplicate-genesis', 'genesis:duplicate-genesis']);
    expect(a.members().map((m) => m.user)).toEqual(['A']);
  });
});

describe('membership and roles', () => {
  it('only an Owner adds members; no self-promotion', () => {
    const { auth } = basicSpace();
    auth.add(addMember('B', 10, 'E', 'viewer')); // editor tries to add
    auth.add(setRole('B', 11, 'B', 'owner')); // editor promotes self
    auth.add(setRole('C', 12, 'C', 'editor')); // viewer promotes self
    expect(auth.currentRole('E')).toBeNull();
    expect(auth.currentRole('B')).toBe('editor');
    expect(auth.currentRole('C')).toBe('viewer');
    expect(inertReasons(auth)).toEqual(['member:owner-required', 'member:owner-required', 'member:owner-required']);
  });

  it('keeps at least one Owner: demoting or removing the last Owner is inert (FR-003)', () => {
    const { auth } = basicSpace();
    auth.add(setRole('A', 10, 'A', 'editor'));
    auth.add(removeMember('A', 11, 'A'));
    expect(auth.currentRole('A')).toBe('owner');
    auth.add(setRole('A', 12, 'B', 'owner'));
    auth.add(setRole('A', 13, 'A', 'editor'));
    expect(auth.currentRole('A')).toBe('editor');
    expect(auth.ownerCount()).toBe(1);
    expect(inertReasons(auth)).toEqual(['member:last-owner', 'member:last-owner']);
  });

  it('role changes are visible in time: roleAt reads the role in force just before a clock', () => {
    const { auth } = basicSpace();
    const demote = setRole('A', 20, 'B', 'viewer');
    auth.add(demote);
    expect(auth.roleAt('B', demote.clock)).toBe('editor'); // before the change
    expect(auth.roleAt('B', demote.clock + 'z')).toBe('viewer');
    expect(auth.currentRole('B')).toBe('viewer');
    expect(auth.roleAt('B', auth.device('B')!.since)).toBeNull(); // before joining
  });

  it('re-adding a current member, role to the same role, and unknown targets are inert', () => {
    const { auth } = basicSpace();
    auth.add(addMember('A', 10, 'B', 'editor'));
    auth.add(setRole('A', 11, 'B', 'editor'));
    auth.add(setRole('A', 12, 'ZZ', 'editor'));
    auth.add(removeMember('A', 13, 'ZZ'));
    expect(inertReasons(auth)).toEqual(['member:already-member', 'member:no-change', 'member:not-a-member', 'member:not-a-member']);
  });

  it('a removed member can be added again; the old devices stay revoked', () => {
    const { auth } = basicSpace();
    auth.add(removeMember('A', 10, 'C', { C: 0 }));
    auth.add(device('A', 11, 'C', 'C2'));
    auth.add(addMember('A', 12, 'C', 'editor'));
    expect(auth.currentRole('C')).toBe('editor');
    expect(auth.device('C')!.revoked).toBeDefined();
    expect(auth.activeDevices('C').map((d) => d.id)).toEqual(['C2']);
  });
});

describe('leaving and removal cutoffs (FR-009)', () => {
  it('any member may remove themselves; the leaving event itself stays valid; later packets do not', () => {
    const { auth } = basicSpace();
    const leave = removeMember('B', 10, 'B', { B: 5 });
    auth.add(leave);
    expect(auth.currentRole('B')).toBeNull();
    expect(auth.state.inert).toEqual([]);
    expect(auth.deviceCheck('B', leave.clock, leave.seq, leave.id)).toMatchObject({ ok: true }); // the event itself is exempt
    expect(auth.deviceCheck('B', leave.clock + 'x', 99, 'B:99')).toEqual({ ok: false, reason: 'revoked' });
  });

  it('a removal cuts a device off by seq as well as by clock', () => {
    const { auth } = basicSpace();
    const rm = removeMember('A', 20, 'B', { B: 7 });
    auth.add(rm);
    const before = clockAt(15, 'B');
    expect(auth.deviceCheck('B', before, 7, 'B:7')).toMatchObject({ ok: true }); // seq at the cutoff, clock before
    expect(auth.deviceCheck('B', before, 8, 'B:8')).toEqual({ ok: false, reason: 'beyond-cutoff' });
    expect(auth.deviceCheck('B', rm.clock + 'x', 1, 'B:1')).toEqual({ ok: false, reason: 'revoked' });
  });

  it('a missing cutoff means no packet of that device is accepted after the removal', () => {
    const { auth } = basicSpace();
    const rm = removeMember('A', 20, 'B');
    auth.add(rm);
    const before = clockAt(15, 'B');
    expect(auth.deviceCheck('B', before, 1, 'B:1')).toEqual({ ok: false, reason: 'beyond-cutoff' });
  });

  it('unknown devices and non-members are refused', () => {
    const { auth } = basicSpace();
    expect(auth.deviceCheck('NOPE', '9', 1, 'NOPE:1')).toEqual({ ok: false, reason: 'unknown-device' });
    expect(auth.deviceCheck('B', clockAt(1, 'B'), 1, 'B:1')).toEqual({ ok: false, reason: 'not-member' });
  });

  it('a removed Owner cannot act afterwards', () => {
    const { auth } = basicSpace();
    auth.add(setRole('A', 10, 'B', 'owner'));
    auth.add(removeMember('B', 11, 'A', { A: 100 }));
    auth.add(addMember('A', 12, 'E', 'viewer')); // A was just removed (clock 11 < 12), seq > cutoff anyway
    expect(auth.currentRole('A')).toBeNull();
    expect(auth.currentRole('E')).toBeNull();
    expect(inertReasons(auth)).toEqual(['member:author-revoked']);
  });
});

describe('invites (FR-014)', () => {
  const withInvite = (over = {}) => {
    const { auth } = basicSpace();
    auth.add(invite('A', 10, 'inv1', 'editor', over));
    return auth;
  };

  it('a valid invite admits a member with the invite role', () => {
    const a = withInvite();
    a.add(device('A', 11, 'E', 'E'));
    a.add(addMember('A', 12, 'E', 'editor', { inviteId: 'inv1' }));
    expect(a.currentRole('E')).toBe('editor');
    expect(a.invite('inv1')!.uses).toHaveLength(1);
  });

  it('refuses expired, used-up, revoked, wrong-role and unknown invites', () => {
    const a = withInvite({ expiresAt: WALL + 10 + 1000, maxUses: 1 });
    a.add(addMember('A', 11, 'E', 'editor', { inviteId: 'inv1' })); // ok
    a.add(addMember('A', 12, 'F', 'editor', { inviteId: 'inv1' })); // used up
    a.add(addMember('A', 13_000, 'G', 'editor', { inviteId: 'inv1' })); // expired
    a.add(invite('A', 20, 'inv2', 'viewer'));
    a.add(addMember('A', 21, 'H', 'editor', { inviteId: 'inv2' })); // role mismatch
    a.add(ev(SYS.inviteRevoke, 'A', 22, { inviteId: 'inv2' }));
    a.add(addMember('A', 23, 'I', 'viewer', { inviteId: 'inv2' })); // revoked
    a.add(addMember('A', 24, 'J', 'viewer', { inviteId: 'nope' }));
    expect(inertReasons(a)).toEqual([
      'member:invite-used-up',
      'member:invite-role-mismatch',
      'member:invite-revoked',
      'member:unknown-invite',
      'member:invite-expired', // the inert list is in clock order, and this event is the latest
    ]);
    const exp = withInvite({ expiresAt: WALL + 10 + 1000 });
    exp.add(addMember('A', 5000, 'E', 'editor', { inviteId: 'inv1' }));
    expect(inertReasons(exp)).toEqual(['member:invite-expired']);
  });

  it('only an Owner creates or revokes invites, and bounds are enforced', () => {
    const { auth } = basicSpace();
    auth.add(invite('B', 10, 'x', 'viewer'));
    auth.add(invite('A', 11, 'y', 'viewer', { maxUses: 0 }));
    auth.add(invite('A', 12, 'z', 'viewer', { expiresAt: WALL + 12 + 31 * DAY }));
    auth.add(invite('A', 13, 'w', 'viewer', { expiresAt: WALL }));
    auth.add(invite('A', 14, 'ok', 'viewer'));
    auth.add(invite('A', 15, 'ok', 'viewer'));
    auth.add(ev(SYS.inviteRevoke, 'B', 16, { inviteId: 'ok' }));
    expect(inertReasons(auth)).toEqual([
      'invite:owner-required',
      'invite:malformed',
      'invite:invite-bounds',
      'invite:invite-bounds',
      'invite:duplicate-invite',
      'invite-revoke:owner-required',
    ]);
  });
});

describe('devices (FR-015)', () => {
  it('a member may add devices for their own user whatever their role', () => {
    const { auth } = basicSpace();
    auth.add(device('C', 10, 'C', 'C2')); // viewer
    expect(auth.activeDevices('C').map((d) => d.id)).toEqual(['C', 'C2']);
  });

  it('but not for another user, unless Owner; duplicates and the per-user limit are inert', () => {
    const { auth } = basicSpace();
    auth.add(device('B', 10, 'C', 'X')); // editor adds a device for someone else
    auth.add(device('A', 11, 'C', 'X')); // owner may
    auth.add(device('A', 12, 'C', 'X')); // duplicate id
    for (let i = 0; i < 12; i++) auth.add(device('C', 20 + i, 'C', `Y${i}`));
    expect(auth.activeDevices('C')).toHaveLength(10);
    expect(inertReasons(auth).slice(0, 2)).toEqual(['device:not-allowed', 'device:duplicate-device']);
    expect(inertReasons(auth).filter((r) => r === 'device:too-many-devices')).toHaveLength(4);
  });

  it('any device of a user, or an Owner, may revoke a device; others may not', () => {
    const { auth } = basicSpace();
    auth.add(device('C', 10, 'C', 'C2'));
    auth.add(ev(SYS.deviceRevoke, 'B', 11, { device: 'C2', cutoff: 0 })); // other editor
    auth.add(ev(SYS.deviceRevoke, 'C', 12, { device: 'C2', cutoff: 3 })); // own user
    auth.add(ev(SYS.deviceRevoke, 'A', 13, { device: 'C2', cutoff: 0 })); // already revoked
    auth.add(ev(SYS.deviceRevoke, 'A', 14, { device: 'NOPE', cutoff: 0 }));
    expect(inertReasons(auth)).toEqual(['device-revoke:not-allowed', 'device-revoke:already-revoked', 'device-revoke:unknown-device']);
    expect(auth.device('C2')!.revoked!.cutoff).toBe(3);
    expect(auth.activeDevices('C').map((d) => d.id)).toEqual(['C']);
  });

  it('a revoked device cannot author events, except within its cutoff', () => {
    const { auth } = basicSpace();
    auth.add(device('C', 10, 'C', 'C2'));
    auth.add(ev(SYS.deviceRevoke, 'C', 11, { device: 'C2', cutoff: 1 }));
    auth.add(device('C2', 12, 'C', 'C3')); // after revocation
    expect(inertReasons(auth)).toEqual(['device:author-revoked']);
  });
});

describe('epochs (FR-008, FR-010)', () => {
  it('only an Owner creates Space epochs; the current one is the highest, ties go to the lowest clock', () => {
    const { auth } = basicSpace();
    auth.add(epoch('A', 10, SPACE, 0, 'aaaaaaaaaaaaaaaa'));
    auth.add(epoch('B', 11, SPACE, 1, 'bbbbbbbbbbbbbbbb')); // editor
    auth.add(epoch('A', 12, SPACE, 1, 'cccccccccccccccc'));
    auth.add(setRole('A', 13, 'D', 'owner'));
    auth.add(epoch('D', 14, SPACE, 1, 'dddddddddddddddd')); // concurrent rotation by another owner
    auth.add(epoch('A', 15, SPACE, 1, 'cccccccccccccccc')); // same key again
    expect(auth.epochs(SPACE).map((e) => e.keyId[0])).toEqual(['a', 'c', 'd']);
    expect(auth.currentEpoch(SPACE)!.keyId).toBe('cccccccccccccccc');
    expect(auth.epochByKeyId(SPACE, 'dddddddddddddddd')!.epoch).toBe(1);
    expect(inertReasons(auth)).toEqual(['epoch:owner-required', 'epoch:duplicate-key']);
  });

  it('rejects malformed epochs and unknown scopes', () => {
    const { auth } = basicSpace();
    auth.add(epoch('A', 10, SPACE, -1, 'aaaaaaaaaaaaaaaa'));
    auth.add(epoch('A', 11, SPACE, 0, 'short'));
    auth.add(epoch('A', 12, 'SHAREXXXXXXXXXXXXXXXXXXXX', 0, 'aaaaaaaaaaaaaaaa'));
    expect(inertReasons(auth)).toEqual(['epoch:malformed', 'epoch:malformed', 'epoch:unknown-scope']);
  });
});

describe('override shares (FR-011)', () => {
  const SHARE = 'SHAREAAAAAAAAAAAAAAAAAAAA';
  const share = (author: string, t: number, members: Array<{ user: string; role: 'owner' | 'editor' | 'viewer' }>, obj = 'obj1', shareId = SHARE) =>
    ev(SYS.share, author, t, { shareId, obj, members });

  it('creates a share with its own members; the creator must own it', () => {
    const { auth } = basicSpace();
    auth.add(share('B', 10, [{ user: 'B', role: 'owner' }, { user: 'D', role: 'editor' }]));
    expect(auth.shareRoleAt(SHARE, 'B', 'z')).toBe('owner');
    expect(auth.shareRoleAt(SHARE, 'D', 'z')).toBe('editor');
    expect(auth.shareRoleAt(SHARE, 'A', 'z')).toBeNull(); // the Space Owner is not in the share (FR-011a)
    expect(auth.shareOfObj('obj1')!.id).toBe(SHARE);
  });

  it('refuses viewers creating, non-members, role cap, duplicates, and a creator that is not the share owner', () => {
    const { auth } = basicSpace();
    auth.add(share('C', 10, [{ user: 'C', role: 'owner' }])); // viewer creates
    auth.add(share('B', 11, [{ user: 'B', role: 'owner' }, { user: 'ZZ', role: 'viewer' }])); // not a Space member
    auth.add(share('B', 12, [{ user: 'B', role: 'owner' }, { user: 'C', role: 'editor' }])); // Space viewer capped
    auth.add(share('B', 13, [{ user: 'B', role: 'editor' }])); // creator must own
    auth.add(share('B', 14, [{ user: 'B', role: 'owner' }], 'obj1'));
    auth.add(share('D', 15, [{ user: 'D', role: 'owner' }], 'obj1', 'OTHERSHARE')); // object already shared
    auth.add(share('D', 16, [{ user: 'D', role: 'owner' }], 'obj2', SHARE)); // duplicate share ID
    expect(inertReasons(auth)).toEqual([
      'share:viewer-cannot-share',
      'share:not-a-space-member',
      'share:role-cap',
      'share:creator-must-own',
      'share:object-already-shared',
      'share:duplicate-share',
    ]);
  });

  it('share members are managed by share owners; the last share owner stays; Space viewers are capped', () => {
    const { auth } = basicSpace();
    auth.add(share('B', 10, [{ user: 'B', role: 'owner' }]));
    auth.add(ev(SYS.shareMember, 'D', 11, { shareId: SHARE, action: 'add', user: 'D', role: 'viewer' })); // D is not in the share
    auth.add(ev(SYS.shareMember, 'B', 12, { shareId: SHARE, action: 'add', user: 'D', role: 'editor' }));
    auth.add(ev(SYS.shareMember, 'B', 13, { shareId: SHARE, action: 'add', user: 'C', role: 'editor' })); // viewer capped
    auth.add(ev(SYS.shareMember, 'B', 14, { shareId: SHARE, action: 'role', user: 'B', role: 'viewer' })); // last owner
    auth.add(ev(SYS.shareMember, 'D', 15, { shareId: SHARE, action: 'remove', user: 'D' })); // leaves
    expect(auth.shareCurrentRole(SHARE, 'D')).toBeNull();
    expect(inertReasons(auth)).toEqual(['share-member:share-owner-required', 'share-member:role-cap', 'share-member:last-share-owner']);
  });

  it('removing a user from the Space removes them from every share, and Space-viewer demotion caps the effective role', () => {
    const { auth } = basicSpace();
    auth.add(share('B', 10, [{ user: 'B', role: 'owner' }, { user: 'D', role: 'editor' }]));
    auth.add(setRole('A', 11, 'D', 'viewer'));
    expect(auth.shareRoleAt(SHARE, 'D', 'zzz')).toBe('viewer');
    auth.add(removeMember('A', 12, 'B', { B: 5 }));
    expect(auth.shareCurrentRole(SHARE, 'B')).toBeNull();
  });

  it('packets before the share predate it; packets after belong to it', () => {
    const { auth } = basicSpace();
    const s = share('B', 10, [{ user: 'B', role: 'owner' }]);
    auth.add(s);
    expect(auth.shareOfObjAt('obj1', s.clock)).toBeUndefined();
    expect(auth.shareOfObjAt('obj1', s.clock + 'x')!.id).toBe(SHARE);
    expect(auth.shareOfObjAt('other', s.clock + 'x')).toBeUndefined();
  });

  it('share epochs need the share owner', () => {
    const { auth } = basicSpace();
    auth.add(share('B', 10, [{ user: 'B', role: 'owner' }, { user: 'D', role: 'editor' }]));
    auth.add(epoch('D', 11, SHARE, 0, 'aaaaaaaaaaaaaaaa'));
    auth.add(epoch('B', 12, SHARE, 0, 'bbbbbbbbbbbbbbbb'));
    auth.add(epoch('A', 13, SHARE, 1, 'cccccccccccccccc')); // Space Owner outside the share
    expect(auth.currentEpoch(SHARE)!.keyId).toBe('bbbbbbbbbbbbbbbb');
    expect(inertReasons(auth)).toEqual(['epoch:share-owner-required', 'epoch:share-owner-required']);
  });
});

describe('add / load', () => {
  it('ignores key grants and duplicates, and load() equals incremental add()', () => {
    const { auth, events } = basicSpace();
    expect(auth.add(events[0]!)).toEqual({ added: false, retroactive: false, newInert: [] });
    expect(auth.add(ev(SYS.keygrant, 'A', 10, { to: 'B', scope: SPACE, eph: '', items: [] })).added).toBe(false);
    const b = new Authority(SPACE);
    b.load([...events].reverse());
    expect(b.stateDigest()).toBe(auth.stateDigest());
    expect(b.eventCount).toBe(events.length);
  });
});
