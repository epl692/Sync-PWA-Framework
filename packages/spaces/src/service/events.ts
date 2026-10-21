import type { Emitter } from '@sync/core';
import type { JoinRequestView, Role } from '../identity/provider';
import type { RejectCode } from '../validators/spacesValidator';

export type SecurityEvent =
  | { kind: 'packet:rejected'; id: string; space: string; reason: RejectCode }
  | { kind: 'packet:waiting-for-key'; id: string; space: string; scope: string; epoch: number }
  | { kind: 'key:rotated'; space: string; scope: string; epoch: number; reason: 'member-removed' | 'device-revoked' | 'invite-surplus' | 'manual' | 'key-exhausted' }
  | { kind: 'member:changed'; space: string; user: string; role: Role | null }
  | { kind: 'member:change-ignored'; space: string; event: string; type: string; reason: string }
  | { kind: 'join:request'; req: JoinRequestView }
  | { kind: 'space:rebuilt'; space: string; reapplied: number; rejected: number }
  | { kind: 'security:unsupported'; reason: string };

export type SecurityEmitter = Emitter<SecurityEvent>;
