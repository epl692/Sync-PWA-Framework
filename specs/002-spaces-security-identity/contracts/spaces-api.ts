/**
 * App-facing API of @sync/spaces. Modules (spec 003) get the Spaces API through the
 * module host; they NEVER receive the keystore, signer, or raw keys (research R-03).
 * All calls are local first; those that need other devices (invites, rotation delivery)
 * complete locally and finish in the background.
 */

import type { SyncCore, SyncableObject, ObjectId } from '../../001-sync-core/contracts/public-api';
import type { IdentityProvider, UserSession, Role, SpaceId, UserId, DeviceId, InviteSpec, InviteArtifact, JoinResult, JoinRequestView, DevicePublic } from './identity-provider';

export interface SpaceInfo {
  id: SpaceId;
  name?: string;
  myRole: Role;
  currentEpoch: number;
  memberCount: number;
}

export interface MemberInfo {
  user: UserId;
  displayName?: string;
  role: Role;
  devices: Array<{ id: DeviceId; name?: string; active: boolean }>;
}

export interface ShareInfo {
  shareId: string;
  obj: ObjectId;
  myRole?: Role;               // undefined: not a member (packets stored and relayed, unreadable)
  members?: Array<{ user: UserId; role: Role }>; // only for members
}

export type SecurityEvent =
  | { kind: 'packet:rejected'; id: string; space: SpaceId; reason: 'bad-signature' | 'not-member' | 'role' | 'revoked' | 'beyond-cutoff' | 'immutable-control' }
  | { kind: 'packet:waiting-for-key'; id: string; space: SpaceId; scope: string; epoch: number }
  | { kind: 'key:rotated'; space: SpaceId; scope: string; epoch: number; reason: 'member-removed' | 'device-revoked' | 'invite-surplus' | 'manual' }
  | { kind: 'member:changed'; space: SpaceId; user: UserId }
  | { kind: 'join:request'; req: JoinRequestView }
  | { kind: 'space:rebuilt'; space: SpaceId; reapplied: number; rejected: number }
  | { kind: 'security:unsupported'; reason: string };

export interface SpacesConfig {
  core: SyncCore;
  provider: IdentityProvider;
  /** IndexedDB name for keys. Default "sync-keys". */
  keyDb?: string;
  /** Called for a join that needs approval (default: refuse). */
  approveJoin?: (req: JoinRequestView) => boolean | Promise<boolean>;
  /** Called before a new device of this user is linked (default: refuse). Show `sas`, the words the new device also shows. */
  approveLink?: (device: DevicePublic, sas: string) => boolean | Promise<boolean>;
  rotationGraceMs?: number;
  /** Auto-rotate and invite defaults. */
  limits?: { maxInviteDays?: number; maxParkedPerAuthor?: number };
}

export interface Spaces {
  /** Resolves 'unsupported' state instead of throwing when Web Crypto lacks Ed25519/X25519. */
  readonly state: 'ready' | 'unsupported';
  session(): UserSession | undefined;
  signUp(displayName?: string): Promise<UserSession>;

  // ---- Spaces ----
  create(name?: string): Promise<SpaceInfo>;                // creator becomes Owner, epoch 0 key generated
  list(): Promise<SpaceInfo[]>;
  members(space: SpaceId): Promise<MemberInfo[]>;
  setRole(space: SpaceId, user: UserId, role: Role): Promise<void>;   // Owner only; last-Owner rule enforced
  remove(space: SpaceId, user: UserId): Promise<void>;                // rotates Space + share keys
  leave(space: SpaceId): Promise<void>;

  // ---- invites (delegate to the provider; framework writes events) ----
  invite(space: SpaceId, spec: Omit<InviteSpec, 'space'>): Promise<InviteArtifact>;
  revokeInvite(space: SpaceId, inviteId: string): Promise<void>;
  accept(artifact: string): Promise<JoinResult>;

  // ---- devices ----
  linkDevice(): Promise<{ code: string; done: Promise<{ device: DeviceId }> }>;
  joinAsDevice(code: string): Promise<UserSession>;
  revokeDevice(device: DeviceId): Promise<void>;                      // rotates affected keys

  // ---- override shares ----
  share(obj: ObjectId, members: Array<{ user: UserId; role: Role }>): Promise<ShareInfo>;
  shareOf(obj: ObjectId): Promise<ShareInfo | undefined>;
  setShareRole(shareId: string, user: UserId, role: Role | 'none'): Promise<void>;

  // ---- introspection ----
  rejectedCount(space: SpaceId): Promise<number>;
  on(cb: (e: SecurityEvent) => void): () => void;
  close(): Promise<void>;
}

export declare function installSpaces(config: SpacesConfig): Promise<Spaces>;
/** Registers the codec (aes-gcm-space/1), signer, validators, snapshot guard, compaction pin and the identity channel. Prefer `openSecureCore`, which also creates the device keys and gives the core the matching device ID. */

export type { SyncableObject };
