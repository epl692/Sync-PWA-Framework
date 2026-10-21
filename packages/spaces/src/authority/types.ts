/**
 * `$sys.*` control events and the Authority State derived from them
 * (contracts/authority-rules.md, data-model.md). Control events are create-only objects in the Space.
 */

export type Role = 'owner' | 'editor' | 'viewer';
export const ROLES: readonly Role[] = ['owner', 'editor', 'viewer'];
export const isRole = (x: unknown): x is Role => x === 'owner' || x === 'editor' || x === 'viewer';

export const SYS_PREFIX = '$sys.';
export const SYS = {
  genesis: '$sys.genesis',
  member: '$sys.member',
  device: '$sys.device',
  deviceRevoke: '$sys.device-revoke',
  invite: '$sys.invite',
  inviteRevoke: '$sys.invite-revoke',
  epoch: '$sys.epoch',
  keygrant: '$sys.keygrant',
  share: '$sys.share',
  shareMember: '$sys.share-member',
} as const;
export type SysType = (typeof SYS)[keyof typeof SYS];
export const isSysType = (t: string): t is SysType => (Object.values(SYS) as string[]).includes(t);

/** Limits from data-model.md. */
export const LIMITS = {
  maxInviteDays: 30,
  maxDevicesPerUser: 10,
  maxMembersPerSpace: 100,
} as const;

export interface Binding {
  kind: string;
  /** base64url */
  proof: string;
}

export interface DeviceKeysWire {
  /** base64url, 32 bytes each */
  signPub: string;
  agreePub: string;
}

export type ControlFields = {
  [SYS.genesis]: { owner: { user: string; device: string; binding: Binding } & DeviceKeysWire; nonce: string; name?: string };
  [SYS.member]: { action: 'add' | 'role' | 'remove'; user: string; role?: Role; inviteId?: string; cutoff?: Record<string, number>; displayName?: string };
  [SYS.device]: { user: string; device: string; binding: Binding; name?: string } & DeviceKeysWire;
  [SYS.deviceRevoke]: { device: string; cutoff: number };
  [SYS.invite]: { inviteId: string; role: Role; expiresAt: number; maxUses: number; secretHash: string; approval: 'required' | 'auto' };
  [SYS.inviteRevoke]: { inviteId: string };
  [SYS.epoch]: { scope: string; epoch: number; keyId: string; prevKeyId?: string };
  [SYS.keygrant]: { to: string; scope: string; eph: string; items: Array<{ epoch: number; keyId: string; nonce: string; wrapped: string }> };
  [SYS.share]: { shareId: string; obj: string; members: Array<{ user: string; role: Role }> };
  [SYS.shareMember]: { shareId: string; action: 'add' | 'role' | 'remove'; user: string; role?: Role; cutoff?: Record<string, number> };
};

/** An applied control packet, as the fold sees it. */
export interface ControlEvent<T extends SysType = SysType> {
  /** Packet ID (`author:seq`). */
  id: string;
  type: T;
  clock: string;
  author: string;
  seq: number;
  fields: ControlFields[T];
}

// ---- derived state ----

export interface RoleSpan {
  clock: string;
  /** null = not a member from this clock on. */
  role: Role | null;
  event: string;
}

export interface UserRec {
  id: string;
  displayName?: string;
  history: RoleSpan[];
  devices: string[];
}

export interface DeviceRec {
  id: string;
  user: string;
  signPub: string;
  agreePub: string;
  name?: string;
  binding: Binding;
  since: string;
  revoked?: { clock: string; cutoff: number; event: string };
}

export interface InviteRec {
  id: string;
  role: Role;
  expiresAt: number;
  maxUses: number;
  secretHash: string;
  approval: 'required' | 'auto';
  creator: string;
  clock: string;
  revoked: boolean;
  uses: Array<{ user: string; event: string; clock: string }>;
}

export interface EpochRec {
  scope: string;
  epoch: number;
  keyId: string;
  prevKeyId?: string;
  clock: string;
  event: string;
  author: string;
}

export interface ShareRec {
  id: string;
  obj: string;
  creator: string;
  since: string;
  members: Map<string, RoleSpan[]>;
}

export interface InertRec {
  event: string;
  type: string;
  author: string;
  clock: string;
  reason: string;
}

export interface AuthState {
  genesis?: { user: string; device: string; clock: string; name?: string };
  users: Map<string, UserRec>;
  devices: Map<string, DeviceRec>;
  invites: Map<string, InviteRec>;
  /** Per scope (Space ID or share ID), every epoch event, in clock order. */
  epochs: Map<string, EpochRec[]>;
  shares: Map<string, ShareRec>;
  shareByObj: Map<string, string>;
  inert: InertRec[];
  lastClock: string;
  /** IDs of events already folded (control events are immutable, so this is a set). */
  seen: Set<string>;
}

export function emptyState(): AuthState {
  return {
    users: new Map(),
    devices: new Map(),
    invites: new Map(),
    epochs: new Map(),
    shares: new Map(),
    shareByObj: new Map(),
    inert: [],
    lastClock: '',
    seen: new Set(),
  };
}
