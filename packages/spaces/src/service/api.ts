/** App-facing API of @sync/spaces (see specs/002-spaces-security-identity/contracts/spaces-api.ts). */

import type { SyncCore, SyncableObject, JSONValue } from '@sync/core';
import type {
  IdentityProvider,
  InviteArtifact,
  InviteSpec,
  JoinRequestView,
  Role,
  UserSession,
} from '../identity/provider';
import type { KeyDb } from '../keystore/keydb';
import type { SecurityEvent } from './events';

export type { SecurityEvent, Role, UserSession, InviteArtifact };

export interface SpaceInfo {
  id: string;
  name?: string;
  myRole: Role;
  currentEpoch: number;
  memberCount: number;
}

export interface MemberInfo {
  user: string;
  displayName?: string;
  role: Role;
  devices: Array<{ id: string; name?: string; active: boolean }>;
}

export interface ShareInfo {
  shareId: string;
  obj: string;
  /** Undefined: this user is not a member of the share. */
  myRole?: Role;
  members?: Array<{ user: string; role: Role }>;
}

export interface SpacesOptions {
  /** Identity provider (who users are, how invites and device links travel). */
  provider: IdentityProvider;
  /** Where device and epoch keys live. A KeyDb, or a database name for IndexedDB (default "sync-keys"). */
  keyDb?: KeyDb | string;
  /** Decide a join request that needs approval. Default: refuse (the `join:request` event is still emitted). */
  approveJoin?: (req: JoinRequestView) => boolean | Promise<boolean>;
  /**
   * Decide whether a new device may be linked to this user. DEFAULT: refuse. A link hands the new device every key the
   * user holds, and the link code travels over QR or text, so the app must show `sas` (the words the new device also shows)
   * and ask the user.
   */
  approveLink?: (
    device: import('../identity/provider').DevicePublic,
    sas: string,
  ) => boolean | Promise<boolean>;
  /** How long a second Owner device waits before rotating for a removal someone else is handling. Default 2000. */
  rotationGraceMs?: number;
  /** Injected clock for tests. */
  now?: () => number;
}

export interface Spaces {
  /** 'unsupported' when Web Crypto lacks Ed25519 or X25519: nothing is created and nothing falls back to plaintext. */
  readonly state: 'ready' | 'unsupported';
  session(): UserSession | undefined;
  signUp(displayName?: string): Promise<UserSession>;

  create(name?: string): Promise<SpaceInfo>;
  list(): Promise<SpaceInfo[]>;
  members(space: string): Promise<MemberInfo[]>;
  setRole(space: string, user: string, role: Role): Promise<void>;
  remove(space: string, user: string): Promise<void>;
  leave(space: string): Promise<void>;

  invite(space: string, spec: Omit<InviteSpec, 'space'>): Promise<InviteArtifact>;
  revokeInvite(space: string, inviteId: string): Promise<void>;
  /** Accept an invite link or scanned QR text. `onSas` shows the joiner the short code the Owner will also see. */
  accept(
    artifact: string,
    opts?: { timeoutMs?: number; onSas?: (sas: string) => void },
  ): Promise<{ space: string; role: Role }>;

  linkDevice(): Promise<{ code: string; done: Promise<{ device: string }> }>;
  /** On the new device: consume the code shown by `linkDevice()`. `onSas` shows the words the other device will ask its user to confirm. */
  joinAsDevice(
    code: string,
    opts?: { timeoutMs?: number; onSas?: (sas: string) => void },
  ): Promise<UserSession>;
  revokeDevice(device: string): Promise<void>;

  share(obj: string, members: Array<{ user: string; role: Role }>): Promise<ShareInfo>;
  /** Create an object that is private to a share from its very first packet. */
  createInShare(
    space: string,
    type: string,
    fields: Record<string, JSONValue>,
    members: Array<{ user: string; role: Role }>,
  ): Promise<{ object: SyncableObject; share: ShareInfo }>;
  shareOf(obj: string): Promise<ShareInfo | undefined>;
  setShareRole(shareId: string, user: string, role: Role | 'none'): Promise<void>;

  rejectedCount(space: string): Promise<number>;
  on(cb: (e: SecurityEvent) => void): () => void;
  /** Resolves when background work (grants, rebuilds, rotations) has settled. Mostly for tests. */
  idle(): Promise<void>;
  close(): Promise<void>;
}

export interface InstallOptions extends SpacesOptions {
  core: SyncCore;
}

export class UnsupportedError extends Error {
  readonly code = 'unsupported';
  constructor(reason: string) {
    super(`Spaces are unavailable: ${reason}`);
    this.name = 'UnsupportedError';
  }
}

export class NotAuthorizedError extends Error {
  readonly code = 'not-authorized';
  constructor(what: string) {
    super(`Not authorized: ${what}`);
    this.name = 'NotAuthorizedError';
  }
}
