/**
 * The Authority State of one Space: a deterministic fold over its `$sys.*` control events
 * (contracts/authority-rules.md). Events are replayed in total clock order (clock, then packet ID). An event
 * that is authentic but not allowed at its point of the replay is *inert*: kept in the log, no effect.
 *
 * Signatures are NOT checked here. Only events that passed the envelope validator reach the fold.
 */

import { canonicalString, parseClock } from '@sync/core';
import {
  LIMITS,
  SYS,
  emptyState,
  isRole,
  type AuthState,
  type ControlEvent,
  type ControlFields,
  type DeviceRec,
  type EpochRec,
  type InertRec,
  type InviteRec,
  type Role,
  type RoleSpan,
  type ShareRec,
  type SysType,
  type UserRec,
} from './types';

const DAY_MS = 24 * 60 * 60 * 1000;
const HEX16 = /^[0-9a-f]{16}$/;

export interface AuthorityOptions {
  maxInviteDays?: number;
  maxDevicesPerUser?: number;
}

export type DeviceCheck =
  | { ok: true; user: string; role: Role }
  | { ok: false; reason: 'unknown-device' | 'not-member' | 'revoked' | 'beyond-cutoff' };

const cmp = (a: ControlEvent, b: ControlEvent) => (a.clock < b.clock ? -1 : a.clock > b.clock ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const wallOf = (clock: string) => parseClock(clock)?.wall ?? 0;
const lastSpan = (h: RoleSpan[]): Role | null => (h.length ? h[h.length - 1]!.role : null);

/** Role in force just before `clock` (strictly earlier spans). */
function roleBefore(h: RoleSpan[], clock: string): Role | null {
  let r: Role | null = null;
  for (const s of h) {
    if (s.clock < clock) r = s.role;
    else break;
  }
  return r;
}

export class Authority {
  private events: ControlEvent[] = [];
  private st: AuthState = emptyState();
  private readonly o: Required<AuthorityOptions>;

  constructor(
    readonly space: string,
    opts: AuthorityOptions = {},
  ) {
    this.o = { maxInviteDays: opts.maxInviteDays ?? LIMITS.maxInviteDays, maxDevicesPerUser: opts.maxDevicesPerUser ?? LIMITS.maxDevicesPerUser };
  }

  get state(): AuthState {
    return this.st;
  }

  get eventCount(): number {
    return this.events.length;
  }

  // ---- building the state ----

  /** Replace everything with this set of events. */
  load(events: ControlEvent[]): void {
    this.events = [...new Map(events.filter((e) => e.type !== SYS.keygrant).map((e) => [e.id, e])).values()].sort(cmp);
    this.refold();
  }

  /**
   * Add one applied control event. Appending in clock order folds incrementally; an event that sorts before
   * the latest folded event refolds from scratch (and is reported as retroactive).
   */
  add(ev: ControlEvent): { added: boolean; retroactive: boolean; newInert: InertRec[] } {
    if (ev.type === SYS.keygrant || this.st.seen.has(ev.id)) return { added: false, retroactive: false, newInert: [] };
    const before = new Set(this.st.inert.map((i) => i.event));
    const retroactive = this.st.lastClock !== '' && ev.clock < this.st.lastClock;
    if (retroactive) {
      this.events.push(ev);
      this.events.sort(cmp);
      this.refold();
    } else {
      this.events.push(ev);
      this.fold(ev);
    }
    return { added: true, retroactive, newInert: this.st.inert.filter((i) => !before.has(i.event)) };
  }

  private refold(): void {
    this.st = emptyState();
    for (const ev of this.events) this.fold(ev);
  }

  private inert(ev: ControlEvent, reason: string): void {
    this.st.inert.push({ event: ev.id, type: ev.type, author: ev.author, clock: ev.clock, reason });
  }

  private fold(ev: ControlEvent): void {
    const st = this.st;
    st.seen.add(ev.id);
    if (ev.clock > st.lastClock) st.lastClock = ev.clock;
    const why = this.apply(ev);
    if (why) this.inert(ev, why);
  }

  // ---- queries used by the validators and the service ----

  hasGenesis(): boolean {
    return !!this.st.genesis;
  }

  genesis() {
    return this.st.genesis;
  }

  /** Role in force just before `clock`. */
  roleAt(user: string, clock: string): Role | null {
    const u = this.st.users.get(user);
    return u ? roleBefore(u.history, clock) : null;
  }

  /** Role after every folded event. */
  currentRole(user: string): Role | null {
    const u = this.st.users.get(user);
    return u ? lastSpan(u.history) : null;
  }

  device(id: string): DeviceRec | undefined {
    return this.st.devices.get(id);
  }

  user(id: string): UserRec | undefined {
    return this.st.users.get(id);
  }

  /** Can this device author a packet at `clock` with `seq`? (FR-007, FR-009) */
  deviceCheck(deviceId: string, clock: string, seq: number, packetId: string): DeviceCheck {
    const d = this.st.devices.get(deviceId);
    if (!d) return { ok: false, reason: 'unknown-device' };
    const r = d.revoked;
    if (r && r.event !== packetId) {
      if (clock >= r.clock) return { ok: false, reason: 'revoked' };
      if (seq > r.cutoff) return { ok: false, reason: 'beyond-cutoff' };
    }
    const role = this.roleAt(d.user, clock);
    if (!role) return { ok: false, reason: 'not-member' };
    return { ok: true, user: d.user, role };
  }

  activeDevices(user: string): DeviceRec[] {
    return (this.st.users.get(user)?.devices ?? []).map((id) => this.st.devices.get(id)!).filter((d) => !d.revoked);
  }

  /** Devices of current members that are not revoked: the recipients of a rotation. */
  recipients(): DeviceRec[] {
    const out: DeviceRec[] = [];
    for (const u of this.st.users.values()) if (lastSpan(u.history)) out.push(...this.activeDevices(u.id));
    return out.sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  members(): Array<{ user: string; role: Role; displayName?: string; devices: DeviceRec[] }> {
    const out = [];
    for (const u of this.st.users.values()) {
      const role = lastSpan(u.history);
      if (role) out.push({ user: u.id, role, displayName: u.displayName, devices: u.devices.map((id) => this.st.devices.get(id)!) });
    }
    return out.sort((a, b) => (a.user < b.user ? -1 : 1));
  }

  ownerCount(): number {
    return this.members().filter((m) => m.role === 'owner').length;
  }

  invite(id: string): InviteRec | undefined {
    return this.st.invites.get(id);
  }

  epochs(scope: string): EpochRec[] {
    return this.st.epochs.get(scope) ?? [];
  }

  /** Highest epoch number; among equal numbers the lowest clock wins (research R-09). */
  currentEpoch(scope: string): EpochRec | undefined {
    let best: EpochRec | undefined;
    for (const e of this.epochs(scope)) if (!best || e.epoch > best.epoch) best = e;
    return best;
  }

  epochByKeyId(scope: string, keyId: string): EpochRec | undefined {
    return this.epochs(scope).find((e) => e.keyId === keyId);
  }

  share(id: string): ShareRec | undefined {
    return this.st.shares.get(id);
  }

  /** The share an object belongs to for a packet at `clock` (earlier packets predate the share). */
  shareOfObjAt(obj: string, clock: string): ShareRec | undefined {
    const id = this.st.shareByObj.get(obj);
    const s = id ? this.st.shares.get(id) : undefined;
    return s && s.since < clock ? s : undefined;
  }

  shareOfObj(obj: string): ShareRec | undefined {
    const id = this.st.shareByObj.get(obj);
    return id ? this.st.shares.get(id) : undefined;
  }

  /** Effective role inside a share at `clock`: the share role, capped by the Space role (a Space Viewer is at most a Viewer). */
  shareRoleAt(shareId: string, user: string, clock: string): Role | null {
    const s = this.st.shares.get(shareId);
    const spans = s?.members.get(user);
    if (!s || !spans) return null;
    const r = roleBefore(spans, clock);
    const space = this.roleAt(user, clock);
    if (!r || !space) return null;
    return space === 'viewer' ? 'viewer' : r;
  }

  shareCurrentRole(shareId: string, user: string): Role | null {
    const spans = this.st.shares.get(shareId)?.members.get(user);
    return spans ? lastSpan(spans) : null;
  }

  shareOwnerCount(shareId: string): number {
    const s = this.st.shares.get(shareId);
    if (!s) return 0;
    let n = 0;
    for (const spans of s.members.values()) if (lastSpan(spans) === 'owner') n++;
    return n;
  }

  /**
   * The clock of the latest event after which someone who may hold this scope's key can no longer be trusted
   * with future data: a member removed, a device revoked, or a surplus invite join. A scope needs a new epoch
   * when this is later than its current epoch event (FR-008).
   */
  lastShrinkClock(scope: string): string {
    const st = this.st;
    let latest = '';
    const bump = (c: string) => {
      if (c > latest) latest = c;
    };
    const holders = (users: Iterable<string>) => {
      for (const u of users) {
        const rec = st.users.get(u);
        for (const id of rec?.devices ?? []) {
          const r = st.devices.get(id)?.revoked;
          if (r) bump(r.clock);
        }
      }
    };
    if (scope === this.space) {
      for (const u of st.users.values()) {
        for (let i = 1; i < u.history.length; i++) if (u.history[i]!.role === null && u.history[i - 1]!.role !== null) bump(u.history[i]!.clock);
      }
      holders(st.users.keys());
      for (const i of st.inert) if (i.type === SYS.member && i.reason === 'invite-used-up') bump(i.clock);
    } else {
      const share = st.shares.get(scope);
      if (!share) return '';
      for (const spans of share.members.values()) {
        for (let i = 1; i < spans.length; i++) if (spans[i]!.role === null && spans[i - 1]!.role !== null) bump(spans[i]!.clock);
      }
      holders(share.members.keys());
    }
    return latest;
  }

  /** Canonical, order-independent description of the derived state (for convergence tests). */
  stateDigest(): string {
    const st = this.st;
    const sortMap = <T>(m: Map<string, T>) => [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    return canonicalString({
      genesis: st.genesis ?? null,
      users: sortMap(st.users),
      devices: sortMap(st.devices),
      invites: sortMap(st.invites),
      epochs: sortMap(st.epochs),
      shares: [...st.shares.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, s]) => [k, { ...s, members: sortMap(s.members) }]),
      inert: [...st.inert].sort((a, b) => (a.event < b.event ? -1 : 1)),
    } as never);
  }

  // ---- the rules ----

  /** Returns a reason when the event is inert, undefined when it took effect. */
  private apply(ev: ControlEvent): string | undefined {
    const st = this.st;
    if (ev.type === SYS.genesis) return this.applyGenesis(ev as ControlEvent<typeof SYS.genesis>);
    if (!st.genesis) return 'no-genesis';
    if (ev.clock <= st.genesis.clock) return 'before-genesis';

    const dev = st.devices.get(ev.author);
    if (!dev) return 'unknown-author';
    const r = dev.revoked;
    if (r && r.event !== ev.id && !(ev.clock < r.clock && ev.seq <= r.cutoff)) return 'author-revoked';
    const authorUser = dev.user;
    const authorRole = lastSpan(st.users.get(authorUser)?.history ?? []);
    if (!authorRole) return 'author-not-member';
    const isOwner = authorRole === 'owner';

    switch (ev.type) {
      case SYS.device:
        return this.applyDevice(ev as ControlEvent<typeof SYS.device>, authorUser, isOwner);
      case SYS.deviceRevoke:
        return this.applyDeviceRevoke(ev as ControlEvent<typeof SYS.deviceRevoke>, authorUser, isOwner);
      case SYS.member:
        return this.applyMember(ev as ControlEvent<typeof SYS.member>, authorUser, isOwner);
      case SYS.invite:
        return this.applyInvite(ev as ControlEvent<typeof SYS.invite>, authorUser, isOwner);
      case SYS.inviteRevoke: {
        if (!isOwner) return 'owner-required';
        const inv = st.invites.get((ev.fields as ControlFields[typeof SYS.inviteRevoke]).inviteId);
        if (!inv) return 'unknown-invite';
        inv.revoked = true;
        return undefined;
      }
      case SYS.epoch:
        return this.applyEpoch(ev as ControlEvent<typeof SYS.epoch>, authorUser, isOwner);
      case SYS.share:
        return this.applyShare(ev as ControlEvent<typeof SYS.share>, authorUser, authorRole);
      case SYS.shareMember:
        return this.applyShareMember(ev as ControlEvent<typeof SYS.shareMember>, authorUser);
      default:
        return 'unknown-type';
    }
  }

  private applyGenesis(ev: ControlEvent<typeof SYS.genesis>): string | undefined {
    const st = this.st;
    const f = ev.fields;
    if (st.genesis) return 'duplicate-genesis';
    if (!f?.owner || f.owner.device !== ev.author) return 'bad-genesis';
    st.genesis = { user: f.owner.user, device: f.owner.device, clock: ev.clock, event: ev.id, name: f.name };
    st.users.set(f.owner.user, { id: f.owner.user, displayName: f.owner.displayName, history: [{ clock: ev.clock, role: 'owner', event: ev.id }], devices: [f.owner.device] });
    st.devices.set(f.owner.device, {
      id: f.owner.device,
      user: f.owner.user,
      signPub: f.owner.signPub,
      agreePub: f.owner.agreePub,
      binding: f.owner.binding ?? { kind: 'genesis', proof: '' },
      since: ev.clock,
    });
    return undefined;
  }

  private ensureUser(id: string): UserRec {
    let u = this.st.users.get(id);
    if (!u) this.st.users.set(id, (u = { id, history: [], devices: [] }));
    return u;
  }

  private applyDevice(ev: ControlEvent<typeof SYS.device>, authorUser: string, isOwner: boolean): string | undefined {
    const f = ev.fields;
    if (!f || typeof f.user !== 'string' || typeof f.device !== 'string' || !f.binding) return 'malformed';
    if (this.st.devices.has(f.device)) return 'duplicate-device';
    if (f.user !== authorUser && !isOwner) return 'not-allowed';
    const u = this.ensureUser(f.user);
    if (this.activeDevices(f.user).length >= this.o.maxDevicesPerUser) return 'too-many-devices';
    u.devices.push(f.device);
    this.st.devices.set(f.device, { id: f.device, user: f.user, signPub: f.signPub, agreePub: f.agreePub, name: f.name, binding: f.binding, since: ev.clock });
    return undefined;
  }

  private applyDeviceRevoke(ev: ControlEvent<typeof SYS.deviceRevoke>, authorUser: string, isOwner: boolean): string | undefined {
    const f = ev.fields;
    const target = this.st.devices.get(f?.device);
    if (!target) return 'unknown-device';
    if (target.revoked) return 'already-revoked';
    if (!isOwner && target.user !== authorUser) return 'not-allowed';
    if (!Number.isInteger(f.cutoff) || f.cutoff < 0) return 'malformed';
    target.revoked = { clock: ev.clock, cutoff: f.cutoff, event: ev.id };
    return undefined;
  }

  private applyMember(ev: ControlEvent<typeof SYS.member>, authorUser: string, isOwner: boolean): string | undefined {
    const st = this.st;
    const f = ev.fields;
    if (!f || typeof f.user !== 'string') return 'malformed';
    const cur = lastSpan(st.users.get(f.user)?.history ?? []);
    const owners = this.ownerCount();
    const span = (role: Role | null): RoleSpan => ({ clock: ev.clock, role, event: ev.id });

    if (f.action === 'add') {
      if (!isOwner) return 'owner-required';
      if (cur) return 'already-member';
      if (!isRole(f.role)) return 'malformed';
      if (f.inviteId !== undefined) {
        const inv = st.invites.get(f.inviteId);
        if (!inv) return 'unknown-invite';
        if (inv.revoked) return 'invite-revoked';
        if (wallOf(ev.clock) >= inv.expiresAt) return 'invite-expired';
        if (inv.role !== f.role) return 'invite-role-mismatch';
        if (inv.uses.length >= inv.maxUses) return 'invite-used-up';
        inv.uses.push({ user: f.user, event: ev.id, clock: ev.clock });
      }
      const u = this.ensureUser(f.user);
      u.history.push(span(f.role));
      if (f.displayName) u.displayName = f.displayName;
      return undefined;
    }
    if (f.action === 'role') {
      if (!isOwner) return 'owner-required';
      if (!cur) return 'not-a-member';
      if (!isRole(f.role)) return 'malformed';
      if (f.role === cur) return 'no-change';
      if (cur === 'owner' && owners <= 1) return 'last-owner';
      st.users.get(f.user)!.history.push(span(f.role));
      return undefined;
    }
    if (f.action === 'remove') {
      if (!isOwner && f.user !== authorUser) return 'owner-required';
      if (!cur) return 'not-a-member';
      if (cur === 'owner' && owners <= 1) return 'last-owner';
      const u = st.users.get(f.user)!;
      u.history.push(span(null));
      for (const id of u.devices) {
        const d = st.devices.get(id)!;
        if (!d.revoked) d.revoked = { clock: ev.clock, cutoff: Math.max(0, f.cutoff?.[id] ?? 0), event: ev.id };
      }
      for (const s of st.shares.values()) {
        const spans = s.members.get(f.user);
        if (spans && lastSpan(spans)) spans.push(span(null));
      }
      return undefined;
    }
    return 'malformed';
  }

  private applyInvite(ev: ControlEvent<typeof SYS.invite>, authorUser: string, isOwner: boolean): string | undefined {
    const f = ev.fields;
    if (!isOwner) return 'owner-required';
    if (!f || typeof f.inviteId !== 'string' || !isRole(f.role) || !Number.isInteger(f.maxUses) || f.maxUses < 1 || typeof f.secretHash !== 'string') return 'malformed';
    if (f.approval !== 'required' && f.approval !== 'auto') return 'malformed';
    if (this.st.invites.has(f.inviteId)) return 'duplicate-invite';
    const now = wallOf(ev.clock);
    if (!(f.expiresAt > now) || f.expiresAt - now > this.o.maxInviteDays * DAY_MS) return 'invite-bounds';
    this.st.invites.set(f.inviteId, {
      id: f.inviteId,
      role: f.role,
      expiresAt: f.expiresAt,
      maxUses: f.maxUses,
      secretHash: f.secretHash,
      approval: f.approval,
      creator: authorUser,
      clock: ev.clock,
      revoked: false,
      uses: [],
    });
    return undefined;
  }

  private applyEpoch(ev: ControlEvent<typeof SYS.epoch>, authorUser: string, isOwner: boolean): string | undefined {
    const f = ev.fields;
    if (!f || typeof f.scope !== 'string' || !Number.isInteger(f.epoch) || f.epoch < 0 || !HEX16.test(f.keyId)) return 'malformed';
    if (f.scope === this.space) {
      if (!isOwner) return 'owner-required';
    } else {
      const share = this.st.shares.get(f.scope);
      if (!share) return 'unknown-scope';
      if (lastSpan(share.members.get(authorUser) ?? []) !== 'owner') return 'share-owner-required';
    }
    const list = this.st.epochs.get(f.scope) ?? [];
    if (list.some((e) => e.keyId === f.keyId)) return 'duplicate-key';
    list.push({ scope: f.scope, epoch: f.epoch, keyId: f.keyId, prevKeyId: f.prevKeyId, clock: ev.clock, event: ev.id, author: ev.author });
    this.st.epochs.set(f.scope, list);
    return undefined;
  }

  private applyShare(ev: ControlEvent<typeof SYS.share>, authorUser: string, authorRole: Role): string | undefined {
    const st = this.st;
    const f = ev.fields;
    if (authorRole === 'viewer') return 'viewer-cannot-share';
    if (!f || typeof f.shareId !== 'string' || typeof f.obj !== 'string' || !Array.isArray(f.members)) return 'malformed';
    if (st.shares.has(f.shareId) || f.shareId === this.space) return 'duplicate-share';
    if (st.shareByObj.has(f.obj)) return 'object-already-shared';
    const seen = new Set<string>();
    let creatorOwns = false;
    for (const m of f.members) {
      if (!m || typeof m.user !== 'string' || !isRole(m.role) || seen.has(m.user)) return 'malformed';
      seen.add(m.user);
      const spaceRole = lastSpan(st.users.get(m.user)?.history ?? []);
      if (!spaceRole) return 'not-a-space-member';
      if (spaceRole === 'viewer' && m.role !== 'viewer') return 'role-cap';
      if (m.user === authorUser && m.role === 'owner') creatorOwns = true;
    }
    if (!creatorOwns) return 'creator-must-own';
    const members = new Map<string, RoleSpan[]>();
    for (const m of f.members) members.set(m.user, [{ clock: ev.clock, role: m.role, event: ev.id }]);
    st.shares.set(f.shareId, { id: f.shareId, obj: f.obj, creator: authorUser, since: ev.clock, members });
    st.shareByObj.set(f.obj, f.shareId);
    return undefined;
  }

  private applyShareMember(ev: ControlEvent<typeof SYS.shareMember>, authorUser: string): string | undefined {
    const st = this.st;
    const f = ev.fields;
    if (!f || typeof f.shareId !== 'string' || typeof f.user !== 'string') return 'malformed';
    const share = st.shares.get(f.shareId);
    if (!share) return 'unknown-share';
    const authorShare = lastSpan(share.members.get(authorUser) ?? []);
    const cur = lastSpan(share.members.get(f.user) ?? []);
    const span = (role: Role | null): RoleSpan => ({ clock: ev.clock, role, event: ev.id });
    const owners = this.shareOwnerCount(f.shareId);
    const spaceRole = lastSpan(st.users.get(f.user)?.history ?? []);

    if (f.action === 'remove') {
      if (authorShare !== 'owner' && f.user !== authorUser) return 'share-owner-required';
      if (!cur) return 'not-in-share';
      if (cur === 'owner' && owners <= 1) return 'last-share-owner';
      share.members.get(f.user)!.push(span(null));
      return undefined;
    }
    if (authorShare !== 'owner') return 'share-owner-required';
    if (!isRole(f.role)) return 'malformed';
    if (!spaceRole) return 'not-a-space-member';
    if (spaceRole === 'viewer' && f.role !== 'viewer') return 'role-cap';
    if (f.action === 'add') {
      if (cur) return 'already-in-share';
      const spans = share.members.get(f.user) ?? [];
      spans.push(span(f.role));
      share.members.set(f.user, spans);
      return undefined;
    }
    if (f.action === 'role') {
      if (!cur) return 'not-in-share';
      if (cur === f.role) return 'no-change';
      if (cur === 'owner' && owners <= 1) return 'last-share-owner';
      share.members.get(f.user)!.push(span(f.role));
      return undefined;
    }
    return 'malformed';
  }
}

export type { SysType };
