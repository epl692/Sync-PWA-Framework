/**
 * Identity Provider contract (FR-013, research R-13). A provider decides WHO someone is and how people and
 * devices find each other. It never touches Space keys, roles or packets: the framework owns those and
 * reaches the provider only through this interface, and the provider reaches the framework only through
 * `ProviderHost`.
 *
 * Every implementation MUST pass `identityProviderContract()` from the test kit package.
 */

import type { GrantBody } from '../crypto/wrap';
import type { Role } from '../authority/types';
import type { InviteSecret } from '../keystore/keystore';

export type { Role, GrantBody, InviteSecret };

export interface DevicePublic {
  deviceId: string;
  signPub: Uint8Array; // Ed25519, 32 bytes
  agreePub: Uint8Array; // X25519, 32 bytes
  name?: string;
}

/** Opaque evidence that a device belongs to a user. Only the provider that issued it can verify it. */
export interface DeviceBinding {
  kind: string;
  proof: Uint8Array;
}

/** This install's device. Private keys are never exposed; the provider can only use them. */
export interface LocalDevice extends DevicePublic {
  /** Signs only messages that begin with "sync-binding/" (device bindings). Anything else is refused, so a provider cannot forge packets. */
  sign(bytes: Uint8Array): Promise<Uint8Array>;
  /** X25519 shared secret with a peer public key (for sealing handshake messages). */
  deriveShared(peerAgreePub: Uint8Array): Promise<Uint8Array>;
}

export interface UserSession {
  user: string;
  displayName?: string;
  device: DevicePublic;
}

export interface InviteSpec {
  space: string;
  role: Role;
  /** Epoch ms. Must be in the future and no more than 30 days away. */
  expiresAt: number;
  /** At least 1. */
  maxUses: number;
  /** Default 'required'. */
  approval?: 'required' | 'auto';
}

/** What the inviter hands out of band (link or QR). */
export interface InviteArtifact {
  inviteId: string;
  /** Shareable link; the secret is in the fragment so a static host never receives it. */
  url: string;
  /** The same content, sized for a QR code. */
  qrPayload: string;
  expiresAt: number;
}

export interface JoinRequestView {
  space: string;
  inviteId: string;
  role: Role;
  deviceName?: string;
  /** Short authentication string both screens show, so a copied or photographed invite can be spotted. */
  sas: string;
}

export type InviteStatus =
  | {
      ok: true;
      space: string;
      role: Role;
      approval: 'required' | 'auto';
      expiresAt: number;
      secretHash: Uint8Array;
      usesLeft: number;
    }
  | { ok: false; reason: 'unknown' | 'expired' | 'used-up' | 'revoked' };

export interface JoinerRequest {
  user: string;
  device: DevicePublic;
  binding: DeviceBinding;
  displayName?: string;
}

/** What the framework gives a joiner once an Owner admitted it. */
export interface JoinGrantData {
  space: string;
  role: Role;
  /** Wrapped epoch keys for the joiner's device (every epoch it is entitled to). */
  grants: GrantBody[];
}

/** What the framework gives a newly linked device of an existing user. */
export interface LinkGrantData {
  user: string;
  displayName?: string;
  /** One entry per Space (and share) the user is in. */
  spaces: Array<{ space: string; role: Role; grants: GrantBody[] }>;
}

export class JoinDeniedError extends Error {
  constructor(
    readonly reason:
      'expired' | 'used-up' | 'revoked' | 'declined' | 'bad-proof' | 'unknown' | 'replayed' | 'timeout',
  ) {
    super(`join denied: ${reason}`);
    this.name = 'JoinDeniedError';
  }
}

export interface ChannelLike {
  send(peerKey: string, payload: Uint8Array, opts?: { space?: string }): Promise<void>;
  broadcast(payload: Uint8Array, opts?: { space?: string }): Promise<number>;
  onMessage(handler: (peerKey: string, payload: Uint8Array) => void): () => void;
  setRoutes(spaces: string[]): void;
}

/** Services the framework gives the provider. The provider uses them; it does not implement them. */
export interface ProviderHost {
  channel: ChannelLike;
  device(): LocalDevice;
  now(): number;
  random(bytes: number): Uint8Array;
  /** Local-only storage for invite secrets and replay nonces (never synced). */
  secrets: {
    get(inviteId: string): Promise<InviteSecret | undefined>;
    put(inviteId: string, v: InviteSecret): Promise<void>;
  };
  /** Small persistent local key-value store for the provider's own state (for example its device binding). Never synced. */
  store: {
    get(key: string): Promise<Uint8Array | undefined>;
    put(key: string, value: Uint8Array): Promise<void>;
  };
  /** Ask the signed-in human to approve a join request. Resolves false on decline or timeout. */
  approve(req: JoinRequestView): Promise<boolean>;
  /** Ask whether a new device may be linked to this user (shown with a short authentication string). */
  approveLink(device: DevicePublic, sas: string): Promise<boolean>;

  // Owner side
  registerInvite(spec: {
    space: string;
    inviteId: string;
    role: Role;
    expiresAt: number;
    maxUses: number;
    secretHash: Uint8Array;
    approval: 'required' | 'auto';
  }): Promise<void>;
  revokeInviteRecord(space: string, inviteId: string): Promise<void>;
  inviteStatus(space: string, inviteId: string): Promise<InviteStatus>;
  /** Write the joiner's device and membership, rotate if needed, and return the keys to deliver. */
  admit(space: string, inviteId: string, joiner: JoinerRequest): Promise<JoinGrantData>;

  // Joiner side
  completeJoin(data: JoinGrantData): Promise<void>;

  // Device linking
  currentSession(): UserSession | undefined;
  /** Existing device: record the new device in every Space of this user and return all the keys it is entitled to. */
  linkNewDevice(device: DevicePublic, binding: DeviceBinding): Promise<LinkGrantData>;
  /** New device: store the keys, adopt the user, and start syncing the Spaces. */
  completeLink(data: LinkGrantData): Promise<void>;
}

export interface IdentityProvider {
  /** Stable plugin ID, e.g. "invite-qr". */
  readonly id: string;
  /** Binding kinds this provider can verify. */
  readonly bindingKinds: readonly string[];

  init(host: ProviderHost): Promise<void>;
  dispose?(): Promise<void>;

  /** Create a user around this install's device. */
  createUser(opts?: { displayName?: string }): Promise<UserSession>;

  /**
   * Is `binding` valid evidence that `device` belongs to `user`? DETERMINISTIC and free of I/O: no clock, no
   * randomness, no network, no host calls (cryptographic verification is allowed). It runs inside packet
   * validators, so it must also never throw: unknown input is simply `false`.
   * `known` are the user's devices already accepted in the Space, so chain-style providers can check the issuer.
   */
  verifyBinding(
    user: string,
    device: DevicePublic,
    binding: DeviceBinding,
    known: ReadonlyArray<DevicePublic>,
  ): Promise<boolean>;

  /** Produce evidence for this install's own device when it becomes a user's first device or is linked. */
  issueBinding(session: UserSession, device: DevicePublic): Promise<DeviceBinding>;

  // ---- linking another device of the same user (User Story 4) ----
  /** On the existing device: returns the code to show (QR or text) and a promise that resolves once the new device is linked. */
  beginLink(session: UserSession): Promise<{ code: string; done: Promise<{ device: string }> }>;
  /** On the new device: consume the code and become a bound device of that user. */
  completeLink(
    code: string,
    opts?: { timeoutMs?: number; onSas?: (sas: string) => void },
  ): Promise<UserSession>;

  // ---- invites (User Story 3) ----
  createInvite(session: UserSession, spec: InviteSpec): Promise<InviteArtifact>;
  revokeInvite(session: UserSession, space: string, inviteId: string): Promise<void>;
  /** Joiner side: consume an artifact (link or scanned QR) and run the handshake. Rejects with JoinDeniedError. */
  acceptInvite(
    session: UserSession,
    artifact: string,
    opts?: { timeoutMs?: number; onSas?: (sas: string) => void },
  ): Promise<{ space: string; role: Role }>;

  /** Provider-side effects of revoking a device (for example telling an org directory). May be a no-op. */
  onDeviceRevoked?(user: string, device: string): Promise<void>;
}
