/**
 * Identity Provider contract (FR-013). A provider decides WHO someone is and how
 * people and devices find each other. It never touches Space keys, signing or roles:
 * the framework owns those (research R-13).
 *
 * Every implementation MUST pass `identityProviderContract()` from @sync/testkit.
 */

import type { PeerId } from '../../001-sync-core/contracts/transport';

export type UserId = string;   // = deviceId of the user's genesis device (default provider)
export type DeviceId = string; // base32(SHA-256(signPub))[0..128 bits]
export type SpaceId = string;
export type Role = 'owner' | 'editor' | 'viewer';

export interface DevicePublicKeys {
  signPub: Uint8Array;   // Ed25519, 32 bytes
  agreePub: Uint8Array;  // X25519, 32 bytes
}

/** Opaque evidence that a device belongs to a user. Interpreted only by the provider that issued it. */
export interface DeviceBinding {
  kind: string;          // e.g. "peer-chain/1", "org-token/1"
  proof: Uint8Array;
}

/** Local handle to this device's keys. Private keys are never exposed (non-extractable). */
export interface LocalDevice {
  deviceId: DeviceId;
  keys: DevicePublicKeys;
  sign(bytes: Uint8Array): Promise<Uint8Array>;
}

export interface UserSession {
  user: UserId;
  device: LocalDevice;
  displayName?: string;
}

export interface InviteSpec {
  space: SpaceId;
  role: Role;
  /** Epoch ms. Required. Default provider caps at 30 days. */
  expiresAt: number;
  /** Required, >= 1. */
  maxUses: number;
  approval?: 'required' | 'auto'; // default 'required'
}

/** What the inviter hands out of band (link or QR). Opaque to apps; the provider defines the string. */
export interface InviteArtifact {
  inviteId: string;
  url: string;            // shareable link, secret in the fragment
  qrPayload: string;      // same content, sized for a QR code
  expiresAt: number;
}

export interface JoinRequestView {
  inviteId: string;
  deviceName?: string;
  /** Short authentication string both screens show, so a photographed QR can be spotted. */
  sas: string;
}

export interface JoinResult {
  space: SpaceId;
  role: Role;
}

/** Services the framework gives the provider. The provider uses them; it does not implement them. */
export interface ProviderHost {
  /** Opaque message channel to peers (core.channel('identity/1')). */
  channel: {
    send(peer: PeerId, payload: Uint8Array): Promise<void>;
    onMessage(h: (peer: PeerId, payload: Uint8Array) => void): () => void;
  };
  /** Ask the signed-in human to approve a join request. Resolves false on decline or timeout. */
  approve(req: JoinRequestView): Promise<boolean>;
  now(): number;
  random(bytes: number): Uint8Array;
}

export interface IdentityProvider {
  /** Stable plugin ID, e.g. "invite-qr". */
  readonly id: string;
  /** Binding kinds this provider can verify; used to route verification. */
  readonly bindingKinds: readonly string[];

  /** Called once when installed. */
  init(host: ProviderHost): Promise<void>;

  /** Create a new user and the genesis device on this install. */
  createUser(opts?: { displayName?: string }): Promise<UserSession>;

  /**
   * PURE and SYNCHRONOUS. Used inside packet validators (no I/O, no clock).
   * True if `binding` proves that `device` belongs to `user`.
   * `known` lists the bindings of the same user already accepted in the Space, in clock order,
   * so peer-chain style providers can check the issuer was already bound.
   */
  verifyBinding(
    user: UserId,
    device: { id: DeviceId; keys: DevicePublicKeys },
    binding: DeviceBinding,
    known: ReadonlyArray<{ id: DeviceId; keys: DevicePublicKeys }>,
  ): boolean;

  /** Produce evidence that `newDevice` belongs to the current user. Runs on an already bound device. */
  issueBinding(session: UserSession, newDevice: { id: DeviceId; keys: DevicePublicKeys }): Promise<DeviceBinding>;

  // ---- linking another device of the same user (User Story 4) ----
  /** On the existing device: start; returns what to show (QR/code). */
  beginLink(session: UserSession): Promise<{ code: string; done: Promise<{ device: DeviceId }> }>;
  /** On the new device: consume the code and become a bound device of the user. */
  completeLink(code: string): Promise<UserSession>;

  // ---- invites (User Story 3) ----
  createInvite(session: UserSession, spec: InviteSpec): Promise<InviteArtifact>;
  revokeInvite(session: UserSession, inviteId: string): Promise<void>;
  /** Joiner side: consume an artifact (link or scanned QR) and run the handshake. */
  acceptInvite(session: UserSession, artifact: string, opts?: { transport?: string }): Promise<JoinResult>;

  /** Provider-side effects of revoking a device (for example, tell an org directory). May be a no-op. */
  onDeviceRevoked?(user: UserId, device: DeviceId): Promise<void>;
}

/** Behaviors the contract suite checks (sketch of the testkit API). */
export interface IdentityProviderContractOptions {
  create(): Promise<{ provider: IdentityProvider; host: ProviderHost; dispose(): Promise<void> }>;
  /** Two providers wired through an in-memory channel, to test the handshakes end to end. */
  pair(): Promise<{ a: IdentityProvider; b: IdentityProvider; dispose(): Promise<void> }>;
}
export declare function identityProviderContract(name: string, opts: IdentityProviderContractOptions): void;
