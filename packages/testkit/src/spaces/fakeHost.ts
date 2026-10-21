/**
 * An in-memory ProviderHost and channel network, so Identity Providers can be exercised in isolation
 * (identityProviderContract). Real keys, fake framework: nothing here writes packets.
 */

import { base32, newId } from '@sync/core';
import {
  type ChannelLike,
  type DevicePublic,
  type DeviceBinding,
  type InviteStatus,
  type InviteSecret,
  type JoinGrantData,
  type JoinRequestView,
  type JoinerRequest,
  type LinkGrantData,
  type LocalDevice,
  type ProviderHost,
  type Role,
  type UserSession,
  deriveShared,
  deviceIdFromSignPub,
  generateAgreeKeyPair,
  generateSignKeyPair,
  signBytes,
} from '@sync/spaces';

type Handler = (peerKey: string, payload: Uint8Array) => void;

export interface Delivery {
  from: string;
  to: string;
  payload: Uint8Array;
}

/** Channel messages between named nodes. Every delivery is asynchronous. */
export class FakeChannelNet {
  private nodes = new Map<string, Set<Handler>>();
  readonly log: Delivery[] = [];
  /** Return null to drop, or bytes to deliver instead. */
  filter?: (d: Delivery) => Uint8Array | null;

  channel(name: string): ChannelLike {
    const handlers = new Set<Handler>();
    this.nodes.set(name, handlers);
    return {
      send: async (peerKey, payload) => this.deliver({ from: name, to: peerKey, payload }),
      broadcast: async (payload) => {
        const others = [...this.nodes.keys()].filter((n) => n !== name);
        for (const to of others) this.deliver({ from: name, to, payload });
        return others.length;
      },
      onMessage: (h) => {
        handlers.add(h);
        return () => void handlers.delete(h);
      },
      setRoutes: () => undefined,
    };
  }

  deliver(d: Delivery): void {
    this.log.push({ ...d, payload: d.payload.slice() });
    const payload = this.filter ? this.filter(d) : d.payload;
    if (!payload) return;
    setTimeout(() => {
      for (const h of [...(this.nodes.get(d.to) ?? [])]) h(d.from, payload.slice());
    }, 0);
  }
}

interface InviteRec {
  space: string;
  role: Role;
  expiresAt: number;
  maxUses: number;
  secretHash: Uint8Array;
  approval: 'required' | 'auto';
  revoked: boolean;
  uses: number;
}

export interface FakeHostCalls {
  approve: JoinRequestView[];
  registerInvite: Array<{ space: string; inviteId: string; role: Role; expiresAt: number; maxUses: number; secretHash: Uint8Array; approval: 'required' | 'auto' }>;
  revokeInviteRecord: Array<{ space: string; inviteId: string }>;
  admit: JoinerRequest[];
  completeJoin: JoinGrantData[];
  linkNewDevice: Array<{ device: DevicePublic; binding: DeviceBinding }>;
  completeLink: LinkGrantData[];
}

export class FakeHost {
  readonly calls: FakeHostCalls = { approve: [], registerInvite: [], revokeInviteRecord: [], admit: [], completeJoin: [], linkNewDevice: [], completeLink: [] };
  /** How often the provider touched the clock, randomness, or the channel (used to prove verifyBinding is pure). */
  readonly touched = { now: 0, random: 0, channel: 0 };
  readonly invites = new Map<string, InviteRec>();
  readonly secretStore = new Map<string, InviteSecret>();
  readonly kv = new Map<string, Uint8Array>();
  session: UserSession | undefined;
  approveWith: (req: JoinRequestView) => boolean | Promise<boolean> = () => true;
  clockMs = 1_700_000_000_000;
  readonly host: ProviderHost;

  private constructor(
    readonly name: string,
    readonly device: LocalDevice,
    channel: ChannelLike,
  ) {
    const self = this;
    this.host = {
      channel: {
        send: (...a) => (self.touched.channel++, channel.send(...a)),
        broadcast: (...a) => (self.touched.channel++, channel.broadcast(...a)),
        onMessage: (h) => channel.onMessage(h),
        setRoutes: (s) => channel.setRoutes(s),
      },
      device: () => device,
      now: () => (self.touched.now++, self.clockMs),
      random: (n) => (self.touched.random++, crypto.getRandomValues(new Uint8Array(n))),
      secrets: {
        get: async (id) => self.secretStore.get(id),
        put: async (id, v) => void self.secretStore.set(id, v),
      },
      store: {
        get: async (k) => self.kv.get(k),
        put: async (k, v) => void self.kv.set(k, v),
      },
      approve: async (req) => (self.calls.approve.push(req), self.approveWith(req)),
      approveLink: async () => true,
      registerInvite: async (spec) => {
        self.calls.registerInvite.push(spec);
        self.invites.set(spec.inviteId, { ...spec, revoked: false, uses: 0 });
      },
      revokeInviteRecord: async (space, inviteId) => {
        self.calls.revokeInviteRecord.push({ space, inviteId });
        const r = self.invites.get(inviteId);
        if (r) r.revoked = true;
      },
      inviteStatus: async (_space, inviteId): Promise<InviteStatus> => {
        const r = self.invites.get(inviteId);
        if (!r) return { ok: false, reason: 'unknown' };
        if (r.revoked) return { ok: false, reason: 'revoked' };
        if (self.clockMs >= r.expiresAt) return { ok: false, reason: 'expired' };
        if (r.uses >= r.maxUses) return { ok: false, reason: 'used-up' };
        return { ok: true, space: r.space, role: r.role, approval: r.approval, expiresAt: r.expiresAt, secretHash: r.secretHash, usesLeft: r.maxUses - r.uses };
      },
      admit: async (space, inviteId, joiner) => {
        self.calls.admit.push(joiner);
        const r = self.invites.get(inviteId)!;
        r.uses++;
        return { space, role: r.role, grants: [] };
      },
      completeJoin: async (data) => void self.calls.completeJoin.push(data),
      currentSession: () => self.session,
      linkNewDevice: async (d, binding) => {
        self.calls.linkNewDevice.push({ device: d, binding });
        return { user: self.session!.user, displayName: self.session!.displayName, spaces: [] };
      },
      completeLink: async (data) => {
        self.calls.completeLink.push(data);
        self.session = { user: data.user, displayName: data.displayName, device: { deviceId: device.deviceId, signPub: device.signPub, agreePub: device.agreePub } };
      },
    };
  }

  static async create(name: string, net: FakeChannelNet): Promise<FakeHost> {
    const sign = await generateSignKeyPair();
    const agree = await generateAgreeKeyPair();
    const deviceId = await deviceIdFromSignPub(sign.publicRaw);
    const device: LocalDevice = {
      deviceId,
      signPub: sign.publicRaw,
      agreePub: agree.publicRaw,
      name,
      sign: (bytes) => signBytes(sign.privateKey, bytes),
      deriveShared: (peer) => deriveShared(agree.privateKey, peer),
    };
    return new FakeHost(name, device, net.channel(name));
  }

  get publicDevice(): DevicePublic {
    return { deviceId: this.device.deviceId, signPub: this.device.signPub, agreePub: this.device.agreePub, name: this.device.name };
  }

  resetTouched(): void {
    this.touched.now = this.touched.random = this.touched.channel = 0;
  }
}

export const newInviteSpace = () => base32(crypto.getRandomValues(new Uint8Array(16)));
export const randomId = () => newId();
