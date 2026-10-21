/**
 * The Spaces service: creates Spaces, enforces and changes membership, rotates keys, distributes grants,
 * runs invites and device links through the Identity Provider, and manages override shares.
 *
 * Everything that changes shared state is a signed `$sys.*` packet written through the core (Principle III).
 * Only secrets stay local (the keystore).
 */

import { Emitter, newId, type JSONValue, type SyncCore, type SyncableObject } from '@sync/core';
import type { Authority } from '../authority/authority';
import { AuthorityHub, type ControlApplied } from '../authority/hub';
import { SYS, type ControlEvent, type ControlFields, type DeviceRec } from '../authority/types';
import { createSnapshotGuard } from '../codec/snapshotGuard';
import { SpaceCodec } from '../codec/spaceCodec';
import { b64urlDecode, b64urlDecodeSafe, b64urlEncode } from '../crypto/b64';
import { hex, randomBytes } from '../crypto/bytes';
import { deviceIdFromSignPub, keyIdOf, spaceIdFor } from '../crypto/ids';
import { createSigner } from '../crypto/signer';
import { deriveShared, signBytes } from '../crypto/suite';
import { unwrapKeys, wrapKeys, type GrantBody } from '../crypto/wrap';
import {
  JoinDeniedError,
  type DeviceBinding,
  type DevicePublic,
  type IdentityProvider,
  type InviteStatus,
  type JoinGrantData,
  type JoinRequestView,
  type JoinerRequest,
  type LinkGrantData,
  type LocalDevice,
  type ProviderHost,
  type Role,
  type UserSession,
} from '../identity/provider';
import type { Keystore } from '../keystore/keystore';
import { createSpacesValidator, type RejectCode } from '../validators/spacesValidator';
import { NotAuthorizedError, type MemberInfo, type ShareInfo, type SpaceInfo, type Spaces, type SpacesOptions } from './api';
import type { SecurityEvent } from './events';
import { createKeyAccess } from './keyAccess';

const FLIP_CODES = new Set<RejectCode>(['role', 'wrong-scope', 'revoked', 'beyond-cutoff']);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface ServiceDeps extends SpacesOptions {
  core: SyncCore;
  keystore: Keystore;
}

const maxSeq = (held: Record<string, Array<[number, number]>>, device: string): number => (held[device] ?? []).reduce((m, [, hi]) => Math.max(m, hi), 0);

export class SpacesService implements Spaces {
  readonly state = 'ready' as const;
  private readonly core: SyncCore;
  private readonly keystore: Keystore;
  private readonly provider: IdentityProvider;
  private readonly hub: AuthorityHub;
  private readonly events = new Emitter<SecurityEvent>();
  private readonly now: () => number;
  private readonly graceMs: number;
  private readonly rejected = new Map<string, number>();
  private readonly flippable = new Map<string, number>();
  private readonly waitingSeen = new Set<string>();
  private readonly revalidating = new Set<string>();
  private quiet = false;
  private closed = false;
  private tail: Promise<unknown> = Promise.resolve();
  private pendingRotations = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly d: ServiceDeps) {
    this.core = d.core;
    this.keystore = d.keystore;
    this.provider = d.provider;
    this.now = d.now ?? (() => Date.now());
    this.graceMs = d.rotationGraceMs ?? 2000;
    this.hub = new AuthorityHub(d.core);
  }

  // ---- setup ----

  async start(): Promise<void> {
    const keys = createKeyAccess({ keystore: this.keystore, hub: this.hub, onKeyWornOut: (scope) => this.enqueue(() => this.rotateScope(scope, 'key-exhausted')) });
    this.hub.onControl = (c) => this.onControl(c);
    this.hub.onGrant = (space, ev, local) => {
      if (!local) this.enqueue(() => this.handleGrant(space, ev));
    };
    this.hub.start();

    this.core.registerCodec(new SpaceCodec(keys), { makeDefault: true });
    this.core.registerSigner(createSigner(this.keystore));
    this.core.registerValidator(
      createSpacesValidator({
        authorities: this.hub,
        verifyBinding: async (user, device, binding, known) => {
          try {
            return await this.provider.verifyBinding(
              user,
              { deviceId: device.id, signPub: device.signPub, agreePub: device.agreePub },
              binding,
              known.map((k) => ({ deviceId: k.id, signPub: k.signPub, agreePub: k.agreePub })),
            );
          } catch {
            return false;
          }
        },
        report: ({ code, space }) => {
          this.rejected.set(space, (this.rejected.get(space) ?? 0) + 1);
          if (FLIP_CODES.has(code)) this.flippable.set(space, (this.flippable.get(space) ?? 0) + 1);
          this.events.emit({ kind: 'packet:rejected', id: '', space, reason: code });
        },
        quiet: () => this.quiet,
        waiting: (w) => {
          if (this.waitingSeen.has(w.id)) return;
          this.waitingSeen.add(w.id);
          this.events.emit({ kind: 'packet:waiting-for-key', ...w });
        },
      }),
    );
    this.core.registerSnapshotGuard(createSnapshotGuard({ keys, keystore: this.keystore, authorities: this.hub, settle: () => this.idle() }));
    this.core.registerCompactionPin((type, obj) => type.startsWith('$sys.') || this.hub.shareOfObjAnywhere(obj) !== undefined);

    await this.provider.init(this.host());
    const known = await this.keystore.spaces();
    this.core.channel('spaces/1').setRoutes(known);
    for (const s of known) this.enqueue(() => this.catchUp(s));
  }

  private enqueue(fn: () => Promise<unknown>): void {
    if (this.closed) return;
    this.tail = this.tail.then(fn, fn).catch((e) => this.fail(e));
  }

  private fail(e: unknown): void {
    this.events.emit({ kind: 'security:unsupported', reason: `background task failed: ${(e as Error)?.message ?? e}` });
  }

  idle(): Promise<void> {
    return (async () => {
      for (let i = 0; i < 20; i++) {
        const t = this.tail;
        await t;
        await new Promise((r) => setTimeout(r, 0));
        if (t === this.tail && this.pendingRotations.size === 0) return;
      }
    })();
  }

  on(cb: (e: SecurityEvent) => void): () => void {
    return this.events.on(cb);
  }

  rejectedCount(space: string): Promise<number> {
    return Promise.resolve(this.rejected.get(space) ?? 0);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const t of this.pendingRotations.values()) clearTimeout(t);
    this.pendingRotations.clear();
    await this.tail;
    this.hub.stop();
    await this.provider.dispose?.();
    await this.keystore.close();
  }

  // ---- identity ----

  private device() {
    return this.keystore.requireDevice();
  }

  private userId(): string {
    const u = this.device().userId;
    if (!u) throw new NotAuthorizedError('sign up first');
    return u;
  }

  session(): UserSession | undefined {
    const d = this.keystore.device();
    if (!d?.userId) return undefined;
    return { user: d.userId, displayName: d.displayName, device: { deviceId: d.deviceId, signPub: d.signPub, agreePub: d.agreePub } };
  }

  async signUp(displayName?: string): Promise<UserSession> {
    const existing = this.session();
    if (existing) return existing;
    const s = await this.provider.createUser({ displayName });
    await this.keystore.setUser(s.user, s.displayName);
    return this.session()!;
  }

  private localDevice(): LocalDevice {
    const self = this;
    const d = this.device();
    return {
      deviceId: d.deviceId,
      signPub: d.signPub,
      agreePub: d.agreePub,
      name: d.displayName,
      sign: (bytes) => signBytes(self.device().signPriv, bytes),
      deriveShared: (peer) => deriveShared(self.device().agreePriv, peer),
    };
  }

  // ---- Spaces ----

  private async requireRole(space: string, ...roles: Role[]): Promise<Authority> {
    const auth = await this.hub.ensure(space);
    const r = auth.currentRole(this.userId());
    if (!r || !roles.includes(r)) throw new NotAuthorizedError(`${roles.join(' or ')} role required in this Space`);
    return auth;
  }

  async create(name?: string): Promise<SpaceInfo> {
    const user = this.userId();
    const dev = this.device();
    const session = this.session()!;
    const nonce = randomBytes(16);
    const space = await spaceIdFor(dev.signPub, nonce);
    const binding = await this.provider.issueBinding(session, session.device);

    const raw = randomBytes(32);
    const keyId = hex(await keyIdOf(raw));
    await this.keystore.putEpochKey(space, 0, raw, 'self');
    await this.keystore.addSpace(space);
    await this.core.create(space, SYS.genesis, {
      owner: { user, device: dev.deviceId, ...(session.displayName ? { displayName: session.displayName } : {}), signPub: b64urlEncode(dev.signPub), agreePub: b64urlEncode(dev.agreePub), binding: { kind: binding.kind, proof: b64urlEncode(binding.proof) } },
      nonce: b64urlEncode(nonce),
      ...(name ? { name } : {}),
    } satisfies ControlFields[typeof SYS.genesis] as never);
    await this.core.create(space, SYS.epoch, { scope: space, epoch: 0, keyId } satisfies ControlFields[typeof SYS.epoch] as never);
    this.core.channel('spaces/1').setRoutes(await this.keystore.spaces());
    return (await this.info(space))!;
  }

  private async info(space: string): Promise<SpaceInfo | undefined> {
    const auth = await this.hub.ensure(space);
    const me = this.device().userId;
    const role = me ? auth.currentRole(me) : null;
    if (!role) return undefined;
    return { id: space, name: auth.genesis()?.name, myRole: role, currentEpoch: auth.currentEpoch(space)?.epoch ?? 0, memberCount: auth.members().length };
  }

  async list(): Promise<SpaceInfo[]> {
    const ids = new Set([...(await this.keystore.spaces()), ...this.hub.spaces()]);
    const out: SpaceInfo[] = [];
    for (const id of [...ids].sort()) {
      const i = await this.info(id);
      if (i) out.push(i);
    }
    return out;
  }

  async members(space: string): Promise<MemberInfo[]> {
    const auth = await this.hub.ensure(space);
    return auth.members().map((m) => ({
      user: m.user,
      displayName: m.displayName,
      role: m.role,
      devices: m.devices.map((d) => ({ id: d.id, name: d.name, active: !d.revoked })),
    }));
  }

  private async write<T extends keyof ControlFields>(space: string, type: T, fields: ControlFields[T]): Promise<void> {
    await this.core.create(space, type, fields as never);
  }

  async setRole(space: string, user: string, role: Role): Promise<void> {
    const auth = await this.requireRole(space, 'owner');
    const cur = auth.currentRole(user);
    if (!cur) throw new NotAuthorizedError('that user is not a member');
    if (cur === 'owner' && role !== 'owner' && auth.ownerCount() <= 1) throw new NotAuthorizedError('a Space needs at least one Owner');
    await this.write(space, SYS.member, { action: 'role', user, role });
  }

  /** Highest sequence number held for each of a user's devices: the removal cutoff (research R-08). */
  private async cutoffFor(space: string, devices: Iterable<string>): Promise<Record<string, number>> {
    const held = await this.core.held(space);
    const out: Record<string, number> = {};
    for (const d of devices) out[d] = maxSeq(held, d);
    return out;
  }

  async remove(space: string, user: string): Promise<void> {
    const auth = await this.requireRole(space, 'owner');
    const rec = auth.user(user);
    if (!rec || !auth.currentRole(user)) throw new NotAuthorizedError('that user is not a member');
    if (auth.currentRole(user) === 'owner' && auth.ownerCount() <= 1) throw new NotAuthorizedError('a Space needs at least one Owner');
    const cutoff = await this.cutoffFor(space, rec.devices);
    await this.write(space, SYS.member, { action: 'remove', user, cutoff });
    await this.rotateIfNeeded(space, 'member-removed');
  }

  async leave(space: string): Promise<void> {
    const user = this.userId();
    const auth = await this.hub.ensure(space);
    const role = auth.currentRole(user);
    if (!role) throw new NotAuthorizedError('you are not a member');
    if (role === 'owner' && auth.ownerCount() <= 1) throw new NotAuthorizedError('the last Owner cannot leave');
    const cutoff = await this.cutoffFor(space, auth.user(user)!.devices);
    await this.write(space, SYS.member, { action: 'remove', user, cutoff });
    // an Owner device rotates once it sees this (or this device does, if it was an Owner of several)
  }

  // ---- control events: reactions ----

  private onControl(c: ControlApplied): void {
    const { space, event } = c;
    const auth = this.hub.authority(space);
    const me = this.device().deviceId;
    for (const i of c.newInert) if (i.author === me) this.events.emit({ kind: 'member:change-ignored', space, event: i.event, type: i.type, reason: i.reason });
    if (event.type === SYS.member) {
      const f = event.fields as ControlFields[typeof SYS.member];
      this.events.emit({ kind: 'member:changed', space, user: f.user, role: auth.currentRole(f.user) });
    }
    if (this.needsRebuild(c)) this.enqueue(() => this.rebuild(space));
    else if (!this.revalidating.has(space)) {
      this.revalidating.add(space);
      this.enqueue(async () => {
        this.revalidating.delete(space);
        await this.core.revalidate({ space });
      });
    }
    this.scheduleRotation(space);
  }

  /** When a control event can change the verdict on packets we already judged (research R-10). */
  private needsRebuild(c: ControlApplied): boolean {
    if (c.retroactive) return true;
    const { space, event } = c;
    const clock = event.clock;
    const gone = (device: string, cutoff: number | undefined) => {
      const m = this.hub.maxAppliedOf(space, device);
      return !!m && (m.seq > (cutoff ?? 0) || m.clock >= clock);
    };
    switch (event.type) {
      case SYS.member: {
        const f = event.fields as ControlFields[typeof SYS.member];
        const auth = this.hub.authority(space);
        const devices = auth.user(f.user)?.devices ?? [];
        if (f.action === 'remove') return devices.some((d) => gone(d, f.cutoff?.[d]));
        if (f.action === 'role' && f.role === 'viewer') return devices.some((d) => (this.hub.maxAppliedOf(space, d)?.clock ?? '') >= clock);
        return (this.flippable.get(space) ?? 0) > 0;
      }
      case SYS.deviceRevoke: {
        const f = event.fields as ControlFields[typeof SYS.deviceRevoke];
        return gone(f.device, f.cutoff);
      }
      case SYS.device:
      case SYS.share:
      case SYS.shareMember:
        return (this.flippable.get(space) ?? 0) > 0;
      default:
        return false;
    }
  }

  private async rebuild(space: string): Promise<void> {
    let reapplied = 0;
    let rejected = 0;
    this.quiet = true;
    try {
      for (let i = 0; i < 6; i++) {
        const r = await this.core.rebuildSpace(space);
        await this.hub.reload(space);
        reapplied += r.reapplied;
        rejected += r.rejected;
        if (!r.reapplied && !r.rejected) break;
      }
    } finally {
      this.quiet = false;
    }
    this.rejected.set(space, (this.rejected.get(space) ?? 0) + rejected);
    this.flippable.set(space, 0);
    this.events.emit({ kind: 'space:rebuilt', space, reapplied, rejected });
    await this.core.revalidate({ space });
  }

  // ---- key grants ----

  private async handleGrant(space: string, ev: ControlEvent<typeof SYS.keygrant>): Promise<void> {
    const dev = this.device();
    const f = ev.fields;
    if (f.to !== dev.deviceId) return;
    const auth = this.hub.authority(space);
    if (f.scope !== space && !auth.share(f.scope)) return;
    const keys = await unwrapKeys(dev.agreePriv, dev.deviceId, f as GrantBody);
    let stored = 0;
    for (const k of keys) {
      if (await this.keystore.hasKey(f.scope, k.keyId)) continue;
      await this.keystore.putEpochKey(f.scope, k.epoch, k.raw, 'grant');
      stored++;
    }
    if (stored) await this.core.revalidate({ space });
  }

  /** Re-read grants addressed to this device from the log (a crash may have lost the live ones). */
  private async catchUp(space: string): Promise<void> {
    const dev = this.device();
    const items = await this.core.scanApplied(space, { typePrefix: SYS.keygrant });
    let stored = 0;
    for (const it of items) {
      const f = it.body.fields as never as ControlFields[typeof SYS.keygrant];
      if (it.body.type !== SYS.keygrant || f.to !== dev.deviceId) continue;
      for (const k of await unwrapKeys(dev.agreePriv, dev.deviceId, f as GrantBody)) {
        if (await this.keystore.hasKey(f.scope, k.keyId)) continue;
        await this.keystore.putEpochKey(f.scope, k.epoch, k.raw, 'grant');
        stored++;
      }
    }
    await this.hub.ensure(space);
    if (stored) await this.core.revalidate({ space });
    this.scheduleRotation(space);
  }

  // ---- rotation (FR-008, research R-09) ----

  private scheduleRotation(space: string): void {
    if (this.pendingRotations.has(space) || this.closed) return;
    const auth = this.hub.authority(space);
    if (!this.scopesNeedingRotation(auth, space).length) return;
    const t = setTimeout(() => {
      this.pendingRotations.delete(space);
      this.enqueue(() => this.rotateIfNeeded(space));
    }, this.graceMs);
    (t as { unref?: () => void }).unref?.();
    this.pendingRotations.set(space, t);
  }

  /** Scopes this device may rotate (Space Owner, or share Owner) whose epoch predates the latest shrink. */
  private scopesNeedingRotation(auth: Authority, space: string): string[] {
    const me = this.device().userId;
    if (!me) return [];
    const mine = auth.activeDevices(me).some((d) => d.id === this.device().deviceId);
    if (!mine) return [];
    const scopes: string[] = [];
    if (auth.currentRole(me) === 'owner') scopes.push(space);
    for (const s of auth.state.shares.values()) if (auth.shareCurrentRole(s.id, me) === 'owner') scopes.push(s.id);
    return scopes.filter((scope) => auth.uncoveredShrinks(scope).length > 0);
  }

  private async rotateIfNeeded(space: string, reason?: 'member-removed' | 'device-revoked' | 'invite-surplus'): Promise<void> {
    const auth = await this.hub.ensure(space);
    for (const scope of this.scopesNeedingRotation(auth, space)) await this.rotate(space, scope, reason ?? this.whyRotate(auth, scope));
  }

  /** What made this scope's key stale, for the event: the latest shrinking event. */
  private whyRotate(auth: Authority, scope: string): 'member-removed' | 'device-revoked' | 'invite-surplus' {
    const latest = auth.uncoveredShrinks(scope).at(-1);
    if (!latest) return 'member-removed';
    if (auth.state.inert.some((i) => i.event === latest.id && i.reason === 'invite-used-up')) return 'invite-surplus';
    const dev = [...auth.state.devices.values()].find((d) => d.revoked?.event === latest.id);
    if (dev && !auth.state.users.get(dev.user)?.history.some((h) => h.event === latest.id)) return 'device-revoked';
    return 'member-removed';
  }

  private spaceOfScope(scope: string): string | undefined {
    for (const s of this.hub.spaces()) {
      if (s === scope || this.hub.authority(s).share(scope)) return s;
    }
    return undefined;
  }

  private async rotateScope(scope: string, reason: 'key-exhausted' | 'manual'): Promise<void> {
    const space = this.spaceOfScope(scope);
    if (space) await this.rotate(space, scope, reason);
  }

  /** New epoch: announce it, wrap the key for every device that should have it, then start using it. */
  private async rotate(space: string, scope: string, reason: 'member-removed' | 'device-revoked' | 'invite-surplus' | 'manual' | 'key-exhausted'): Promise<void> {
    const auth = await this.hub.ensure(space);
    const cur = auth.currentEpoch(scope);
    const held = await this.keystore.epochs(scope);
    const epoch = Math.max(cur?.epoch ?? -1, ...held.map((h) => h.epoch)) + 1;
    const raw = randomBytes(32);
    const keyId = hex(await keyIdOf(raw));
    const me = this.device().deviceId;
    const recipients = this.recipientsOf(auth, space, scope).filter((r) => r.id !== me);

    // Written while the old key is still the write key, so members who have not seen the new one can read these.
    const covers = auth.shrinkEvents(scope).map((s) => s.id);
    await this.write(space, SYS.epoch, { scope, epoch, keyId, ...(cur ? { prevKeyId: cur.keyId } : {}), covers });
    for (const r of recipients) {
      const grant = await wrapKeys(scope, { deviceId: r.id, agreePub: b64urlDecode(r.agreePub) }, [{ epoch, keyId, raw }]);
      await this.write(space, SYS.keygrant, grant);
    }
    await this.keystore.putEpochKey(scope, epoch, raw, 'self');
    this.events.emit({ kind: 'key:rotated', space, scope, epoch, reason });
  }

  private recipientsOf(auth: Authority, space: string, scope: string): DeviceRec[] {
    if (scope === space) return auth.recipients();
    const share = auth.share(scope);
    if (!share) return [];
    const out: DeviceRec[] = [];
    for (const user of share.members.keys()) if (auth.shareCurrentRole(scope, user)) out.push(...auth.activeDevices(user));
    return out.sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  // ---- invites (User Story 3) ----

  async invite(space: string, spec: Omit<import('../identity/provider').InviteSpec, 'space'>) {
    await this.requireRole(space, 'owner');
    return this.provider.createInvite(this.session()!, { ...spec, space });
  }

  async revokeInvite(space: string, inviteId: string): Promise<void> {
    await this.requireRole(space, 'owner');
    await this.provider.revokeInvite(this.session()!, space, inviteId);
  }

  accept(artifact: string, opts?: { timeoutMs?: number; onSas?: (sas: string) => void }) {
    return this.provider.acceptInvite(this.session() ?? this.noSession(), artifact, opts);
  }

  private noSession(): never {
    throw new NotAuthorizedError('sign up first');
  }

  // ---- devices (User Story 4) ----

  linkDevice() {
    return this.provider.beginLink(this.session() ?? this.noSession());
  }

  async joinAsDevice(code: string): Promise<UserSession> {
    return this.provider.completeLink(code);
  }

  async revokeDevice(device: string): Promise<void> {
    const user = this.userId();
    for (const space of await this.mySpaces()) {
      const auth = await this.hub.ensure(space);
      const dev = auth.device(device);
      if (!dev || dev.user !== user || dev.revoked) continue;
      const held = await this.core.held(space);
      await this.write(space, SYS.deviceRevoke, { device, cutoff: maxSeq(held, device) });
      await this.rotateIfNeeded(space, 'device-revoked');
    }
    await this.provider.onDeviceRevoked?.(user, device);
  }

  private async mySpaces(): Promise<string[]> {
    return (await this.list()).map((s) => s.id);
  }

  // ---- the host the Identity Provider talks to ----

  private host(): ProviderHost {
    const self = this;
    return {
      channel: this.core.channel('identity/1'),
      device: () => self.localDevice(),
      now: () => self.now(),
      random: (n) => randomBytes(n),
      secrets: { get: (id) => self.keystore.getInvite(id), put: (id, v) => self.keystore.putInvite(id, v) },
      store: { get: (k) => self.keystore.getLocal(k), put: (k, v) => self.keystore.putLocal(k, v) },
      approveLink: async (device, sas) => (await self.d.approveLink?.(device, sas)) ?? true,
      approve: async (req: JoinRequestView) => {
        self.events.emit({ kind: 'join:request', req });
        return (await self.d.approveJoin?.(req)) ?? false;
      },

      async registerInvite(spec) {
        await self.requireRole(spec.space, 'owner');
        await self.write(spec.space, SYS.invite, {
          inviteId: spec.inviteId,
          role: spec.role,
          expiresAt: spec.expiresAt,
          maxUses: spec.maxUses,
          secretHash: b64urlEncode(spec.secretHash),
          approval: spec.approval,
        });
      },

      async revokeInviteRecord(space, inviteId) {
        await self.requireRole(space, 'owner');
        await self.write(space, SYS.inviteRevoke, { inviteId });
      },

      async inviteStatus(space, inviteId): Promise<InviteStatus> {
        const inv = (await self.hub.ensure(space)).invite(inviteId);
        if (!inv) return { ok: false, reason: 'unknown' };
        if (inv.revoked) return { ok: false, reason: 'revoked' };
        if (self.now() >= inv.expiresAt) return { ok: false, reason: 'expired' };
        if (inv.uses.length >= inv.maxUses) return { ok: false, reason: 'used-up' };
        return { ok: true, space, role: inv.role, approval: inv.approval, expiresAt: inv.expiresAt, secretHash: b64urlDecode(inv.secretHash), usesLeft: inv.maxUses - inv.uses.length };
      },

      admit: (space, inviteId, joiner) => self.serialAdmit(() => self.admit(space, inviteId, joiner)),
      completeJoin: (data) => self.completeJoin(data),
      currentSession: () => self.session(),
      linkNewDevice: (device, binding) => self.linkNewDevice(device, binding),
      completeLink: (data) => self.completeLink(data),
    };
  }

  private admitTail: Promise<unknown> = Promise.resolve();

  /** Joins are admitted one at a time, so two joiners racing for a single-use invite cannot both pass the use check. */
  private serialAdmit<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.admitTail.then(fn, fn);
    this.admitTail = run.catch(() => undefined);
    return run;
  }

  /** Owner side of a join: record the device and the membership, and wrap the keys for the joiner. */
  private async admit(space: string, inviteId: string, joiner: JoinerRequest): Promise<JoinGrantData> {
    const auth = await this.requireRole(space, 'owner');
    const inv = auth.invite(inviteId);
    if (!inv) throw new JoinDeniedError('unknown');
    const already = auth.currentRole(joiner.user);
    if (!already) {
      if (inv.revoked) throw new JoinDeniedError('revoked');
      if (this.now() >= inv.expiresAt) throw new JoinDeniedError('expired');
      if (inv.uses.length >= inv.maxUses) throw new JoinDeniedError('used-up');
    }
    // verify the evidence before writing anything
    if (!(await this.provider.verifyBinding(joiner.user, joiner.device, joiner.binding, []))) throw new JoinDeniedError('bad-proof');
    if (!auth.device(joiner.device.deviceId)) {
      await this.write(space, SYS.device, {
        user: joiner.user,
        device: joiner.device.deviceId,
        signPub: b64urlEncode(joiner.device.signPub),
        agreePub: b64urlEncode(joiner.device.agreePub),
        binding: { kind: joiner.binding.kind, proof: b64urlEncode(joiner.binding.proof) },
        ...(joiner.device.name ? { name: joiner.device.name } : {}),
      });
    }
    if (!already) {
      await this.write(space, SYS.member, { action: 'add', user: joiner.user, role: inv.role, inviteId, ...(joiner.displayName ? { displayName: joiner.displayName } : {}) });
    }
    const role = (await this.hub.ensure(space)).currentRole(joiner.user) ?? inv.role;
    return { space, role, grants: await this.grantsFor(space, space, joiner.device) };
  }

  /**
   * Every key of one scope, wrapped for one device (FR-010: a new member is entitled to all existing epochs). This is
   * not optional: the Space's own control history is encrypted under the older keys, so a device without them could
   * not even learn who the members are.
   */
  private async grantsFor(_space: string, scope: string, device: DevicePublic): Promise<GrantBody[]> {
    const held = await this.keystore.epochs(scope);
    if (!held.length) return [];
    const chosen = held;
    const items: Array<{ epoch: number; keyId: string; raw: Uint8Array }> = [];
    for (const h of chosen) {
      const raw = await this.keystore.rawKey(scope, h.keyId);
      if (raw) items.push({ epoch: h.epoch, keyId: h.keyId, raw });
    }
    return items.length ? [await wrapKeys(scope, { deviceId: device.deviceId, agreePub: device.agreePub }, items)] : [];
  }

  private async storeGrants(grants: GrantBody[]): Promise<void> {
    const dev = this.device();
    for (const g of grants) {
      for (const k of await unwrapKeys(dev.agreePriv, dev.deviceId, g)) {
        if (!(await this.keystore.hasKey(g.scope, k.keyId))) await this.keystore.putEpochKey(g.scope, k.epoch, k.raw, 'join');
      }
    }
  }

  private async completeJoin(data: JoinGrantData): Promise<void> {
    await this.storeGrants(data.grants);
    await this.keystore.addSpace(data.space);
    this.core.channel('spaces/1').setRoutes(await this.keystore.spaces());
    this.enqueue(() => this.core.revalidate({ space: data.space }));
  }

  /** Existing device side of linking: register the new device in each of my Spaces and hand over every key. */
  private async linkNewDevice(device: DevicePublic, binding: DeviceBinding): Promise<LinkGrantData> {
    const session = this.session() ?? this.noSession();
    const spaces: LinkGrantData['spaces'] = [];
    for (const space of await this.mySpaces()) {
      const auth = await this.hub.ensure(space);
      const role = auth.currentRole(session.user);
      if (!role) continue;
      if (!auth.device(device.deviceId)) {
        await this.write(space, SYS.device, {
          user: session.user,
          device: device.deviceId,
          signPub: b64urlEncode(device.signPub),
          agreePub: b64urlEncode(device.agreePub),
          binding: { kind: binding.kind, proof: b64urlEncode(binding.proof) },
          ...(device.name ? { name: device.name } : {}),
        });
      }
      const grants: GrantBody[] = [];
      const scopes = [space, ...[...auth.state.shares.keys()].filter((s) => auth.shareCurrentRole(s, session.user))];
      for (const scope of scopes) grants.push(...(await this.grantsFor(space, scope, device)));
      spaces.push({ space, role, grants });
    }
    return { user: session.user, displayName: session.displayName, spaces };
  }

  private async completeLink(data: LinkGrantData): Promise<void> {
    await this.keystore.setUser(data.user, data.displayName);
    for (const s of data.spaces) {
      await this.storeGrants(s.grants);
      await this.keystore.addSpace(s.space);
    }
    this.core.channel('spaces/1').setRoutes(await this.keystore.spaces());
    for (const s of data.spaces) this.enqueue(() => this.core.revalidate({ space: s.space }));
  }

  // ---- override shares (User Story 6) ----

  private spaceOfShare(shareId: string): string | undefined {
    return this.spaceOfScope(shareId);
  }

  private shareInfo(auth: Authority, shareId: string): ShareInfo | undefined {
    const s = auth.share(shareId);
    if (!s) return undefined;
    const me = this.device().userId;
    const myRole = me ? (auth.shareCurrentRole(shareId, me) ?? undefined) : undefined;
    const members = myRole ? [...s.members.keys()].map((user) => ({ user, role: auth.shareCurrentRole(shareId, user) })).filter((m): m is { user: string; role: Role } => !!m.role) : undefined;
    return { shareId, obj: s.obj, myRole, members };
  }

  private async createShare(space: string, obj: string, members: Array<{ user: string; role: Role }>): Promise<ShareInfo> {
    const auth = await this.requireRole(space, 'owner', 'editor');
    const me = this.userId();
    const list = members.some((m) => m.user === me) ? members.map((m) => (m.user === me ? { ...m, role: 'owner' as Role } : m)) : [...members, { user: me, role: 'owner' as Role }];
    for (const m of list) {
      const spaceRole = auth.currentRole(m.user);
      if (!spaceRole) throw new NotAuthorizedError(`${m.user} is not a member of this Space`);
      if (spaceRole === 'viewer' && m.role !== 'viewer') throw new NotAuthorizedError('a Space viewer can be at most a viewer in a share');
    }
    if (auth.shareOfObj(obj)) throw new NotAuthorizedError('this object is already in a share');
    const shareId = newId();
    const raw = randomBytes(32);
    const keyId = hex(await keyIdOf(raw));
    await this.write(space, SYS.share, { shareId, obj, members: list });
    await this.write(space, SYS.epoch, { scope: shareId, epoch: 0, keyId });
    const fresh = this.hub.authority(space);
    const myDevice = this.device().deviceId;
    for (const r of this.recipientsOf(fresh, space, shareId).filter((x) => x.id !== myDevice)) {
      await this.write(space, SYS.keygrant, await wrapKeys(shareId, { deviceId: r.id, agreePub: b64urlDecode(r.agreePub) }, [{ epoch: 0, keyId, raw }]));
    }
    await this.keystore.putEpochKey(shareId, 0, raw, 'self');
    return this.shareInfo(fresh, shareId)!;
  }

  async share(obj: string, members: Array<{ user: string; role: Role }>): Promise<ShareInfo> {
    const o = await this.core.get(obj);
    if (!o) throw new NotAuthorizedError('unknown object');
    return this.createShare(o.space, obj, members);
  }

  async createInShare(space: string, type: string, fields: Record<string, JSONValue>, members: Array<{ user: string; role: Role }>): Promise<{ object: SyncableObject; share: ShareInfo }> {
    const id = newId();
    const share = await this.createShare(space, id, members);
    const object = await this.core.create(space, type, fields, { id });
    return { object, share };
  }

  async shareOf(obj: string): Promise<ShareInfo | undefined> {
    const o = await this.core.get(obj);
    const spaces = o ? [o.space] : this.hub.spaces();
    for (const s of spaces) {
      const auth = await this.hub.ensure(s);
      const sh = auth.shareOfObj(obj);
      if (sh) return this.shareInfo(auth, sh.id);
    }
    return undefined;
  }

  async setShareRole(shareId: string, user: string, role: Role | 'none'): Promise<void> {
    const space = this.spaceOfShare(shareId);
    if (!space) throw new NotAuthorizedError('unknown share');
    const auth = await this.hub.ensure(space);
    const me = this.userId();
    if (auth.shareCurrentRole(shareId, me) !== 'owner' && !(role === 'none' && user === me)) throw new NotAuthorizedError('only a share Owner manages its members');
    const cur = auth.shareCurrentRole(shareId, user);
    if (role === 'none') {
      if (!cur) return;
      if (cur === 'owner' && auth.shareOwnerCount(shareId) <= 1) throw new NotAuthorizedError('a share needs at least one Owner');
      await this.write(space, SYS.shareMember, { shareId, action: 'remove', user });
      await this.rotateIfNeeded(space, 'member-removed');
      return;
    }
    if (cur) {
      if (cur === role) return;
      if (auth.currentRole(user) === 'viewer' && role !== 'viewer') throw new NotAuthorizedError('a Space viewer can be at most a viewer in a share');
      if (cur === 'owner' && role !== 'owner' && auth.shareOwnerCount(shareId) <= 1) throw new NotAuthorizedError('a share needs at least one Owner');
      await this.write(space, SYS.shareMember, { shareId, action: 'role', user, role });
      return;
    }
    const spaceRole = auth.currentRole(user);
    if (!spaceRole) throw new NotAuthorizedError('that user is not a member of the Space');
    if (spaceRole === 'viewer' && role !== 'viewer') throw new NotAuthorizedError('a Space viewer can be at most a viewer in a share');
    await this.write(space, SYS.shareMember, { shareId, action: 'add', user, role });
    for (const d of this.hub.authority(space).activeDevices(user)) {
      for (const g of await this.grantsFor(space, shareId, { deviceId: d.id, signPub: b64urlDecode(d.signPub), agreePub: b64urlDecode(d.agreePub) })) await this.write(space, SYS.keygrant, g);
    }
  }
}

void sleep;
void deviceIdFromSignPub;
void b64urlDecodeSafe;
