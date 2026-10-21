/**
 * The packet validator that enforces Zero-Trust (Principle V): every peer checks the signature, the author's
 * standing, and the operation against the author's role in the packet's scope, before applying or relaying.
 *
 * Verdicts:
 *   reject  the packet can never be valid under any state we could learn later, OR it is definitively not
 *           allowed under what we know (it is not stored as applied, and not relayed). A later change of
 *           authority reconsiders it through `rebuildSpace`.
 *   defer   we may simply lack information (the author's device record, a share definition). Stored, kept
 *           out of the state, retried on `revalidate()`.
 *
 * Order (contracts/crypto-envelope.md): signature -> standing -> scope -> role/operation.
 */

import {
  b64urlDecode,
  canonicalBytes,
  parseJsonBytes,
  type DataPacketEnvelope,
  type PacketBody,
  type PacketValidator,
  type ValidationPhase,
  type ValidationResult,
  type ValidatorContext,
} from '@sync/core';
import type { Authority } from '../authority/authority';
import type { AuthorityView } from '../authority/hub';
import { checkFields } from '../authority/schema';
import { SYS, SYS_PREFIX, type ControlFields, type Role } from '../authority/types';
import { SPACE_CODEC_ID, parseHeader } from '../codec/spaceCodec';
import { equalBytes, hex } from '../crypto/bytes';
import { deviceIdFromSignPub, spaceIdFor } from '../crypto/ids';
import { SIGNATURE_BYTES, verifySignature } from '../crypto/suite';

export type RejectCode =
  | 'bad-signature'
  | 'not-member'
  | 'role'
  | 'revoked'
  | 'beyond-cutoff'
  | 'immutable-control'
  | 'wrong-scope'
  | 'malformed'
  | 'bad-genesis'
  | 'bad-binding'
  | 'device-id-mismatch';

export interface BindingVerifier {
  (user: string, device: { id: string; signPub: Uint8Array; agreePub: Uint8Array }, binding: { kind: string; proof: Uint8Array }, known: ReadonlyArray<{ id: string; signPub: Uint8Array; agreePub: Uint8Array }>): Promise<boolean>;
}

export interface ValidatorDeps {
  authorities: AuthorityView;
  verifyBinding: BindingVerifier;
  /** Called for each rejection so the service can count and report it. */
  report?(r: { code: RejectCode; id: string; space: string }): void;
  /** Suppress reporting while the service replays a Space. */
  quiet?(): boolean;
}

const reject = (code: RejectCode, detail?: string): ValidationResult => ({ verdict: 'reject', reason: detail ? `${code}: ${detail}` : code });
const defer = (reason: string): ValidationResult => ({ verdict: 'defer', reason });
const ACCEPT: ValidationResult = { verdict: 'accept' };

/** The bytes a signature covers: the received envelope with `sig` set to null (keeps unknown extra fields). */
export function signingInput(raw: Uint8Array): Uint8Array {
  const o = parseJsonBytes(raw) as Record<string, unknown>;
  o.sig = null;
  return canonicalBytes(o as never);
}

const canWrite = (r: Role | null): boolean => r === 'owner' || r === 'editor';

export function createSpacesValidator(deps: ValidatorDeps): PacketValidator {
  const verified = new Map<string, boolean>();
  const remember = (k: string, v: boolean) => {
    if (verified.size > 50_000) verified.clear();
    verified.set(k, v);
  };

  async function checkSignature(env: DataPacketEnvelope, body: PacketBody | undefined, auth: Authority, raw: Uint8Array | undefined): Promise<ValidationResult | undefined> {
    if (!env.sig) return reject('bad-signature', 'unsigned');
    if (env.sig.byteLength !== SIGNATURE_BYTES) return defer('unknown-signature-suite');
    if (!raw) return reject('bad-signature', 'no envelope bytes');
    const cacheKey = `${env.id}:${hex(env.sig)}`;
    const hit = verified.get(cacheKey);
    if (hit !== undefined) return hit ? undefined : reject('bad-signature');

    let pub: Uint8Array | undefined;
    const dev = auth.device(env.author);
    if (dev) pub = b64urlDecode(dev.signPub);
    else if (body?.type === SYS.genesis && !auth.hasGenesis()) {
      const owner = (body.fields as Partial<ControlFields[typeof SYS.genesis]>).owner;
      if (owner && typeof owner.signPub === 'string') pub = b64urlDecode(owner.signPub);
    }
    if (!pub) return defer('unknown-device');
    if ((await deviceIdFromSignPub(pub)) !== env.author) {
      remember(cacheKey, false);
      return reject('bad-signature', 'key does not match the author ID');
    }
    const ok = await verifySignature(pub, env.sig, signingInput(raw));
    remember(cacheKey, ok);
    return ok ? undefined : reject('bad-signature');
  }

  async function validate(phase: ValidationPhase, env: DataPacketEnvelope, body: PacketBody | undefined, ctx: ValidatorContext): Promise<ValidationResult> {
    if (env.codec !== SPACE_CODEC_ID) return defer('foreign-codec');
    const header = parseHeader(env.body);
    if (!header) return env.body[0] !== undefined && env.body[0] !== 1 ? defer('unknown-format') : reject('malformed', 'no header');
    const auth = await deps.authorities.ensure(env.space);
    const local = phase === 'send' || ctx.source === 'local';
    const genesisBootstrap = body?.type === SYS.genesis && !auth.hasGenesis();

    // 1. signature (our own packets are signed a moment ago by us)
    if (!local) {
      const bad = await checkSignature(env, body, auth, ctx.raw);
      if (bad) return bad;
    }

    // 2. standing of the author device at the packet's clock and sequence number
    let user = '';
    let role: Role | null = null;
    if (genesisBootstrap) {
      user = env.author;
      role = 'owner';
    } else {
      const dc = auth.deviceCheck(env.author, env.clock, env.seq, env.id);
      if (!dc.ok) {
        if (dc.reason === 'unknown-device') return defer('unknown-device');
        if (dc.reason === 'not-member') return defer('not-member');
        return reject(dc.reason);
      }
      user = dc.user;
      role = dc.role;
    }

    // 3. scope: the Space, or an override share named in the readable header
    const inSpaceScope = header.scope === env.space;
    if (!inSpaceScope && role === 'viewer') return reject('role', 'a Viewer cannot write in a share');
    if (!body) return ACCEPT; // cannot read it (no key): signature and standing are all we can check

    if (body.type.startsWith(SYS_PREFIX)) {
      if (!inSpaceScope) return reject('wrong-scope', 'control events live in the Space scope');
      return validateControl(env, body, auth, user, role, genesisBootstrap);
    }

    // 4. role and scope binding for ordinary objects
    const share = auth.shareOfObjAt(body.obj, env.clock);
    if (share) {
      if (header.scope !== share.id) return reject('wrong-scope', 'the object is in an override share');
      const sr = auth.shareRoleAt(share.id, user, env.clock);
      return canWrite(sr) ? ACCEPT : reject('role', 'share role');
    }
    if (!inSpaceScope) {
      const claimed = auth.share(header.scope);
      return claimed ? reject('wrong-scope', 'not the object of this share') : defer('unknown-share');
    }
    return canWrite(role) ? ACCEPT : reject('role');
  }

  async function validateControl(
    env: DataPacketEnvelope,
    body: PacketBody,
    auth: Authority,
    user: string,
    role: Role | null,
    genesisBootstrap: boolean,
  ): Promise<ValidationResult> {
    if (body.op !== 'create') return reject('immutable-control');
    const bad = checkFields(body.type, body.fields);
    if (bad) return reject('malformed', bad);
    const f = body.fields as never as Record<string, any>;
    const owner = role === 'owner';

    switch (body.type) {
      case SYS.genesis: {
        const o = f.owner as { user: string; device: string; signPub: string; agreePub: string };
        if (o.device !== env.author || o.user !== o.device) return reject('bad-genesis', 'owner is not the author');
        const pub = b64urlDecode(o.signPub);
        if ((await deviceIdFromSignPub(pub)) !== o.device) return reject('bad-genesis', 'device ID does not hash the key');
        if ((await spaceIdFor(pub, b64urlDecode(f.nonce))) !== env.space) return reject('bad-genesis', 'Space ID is not derived from this key');
        return ACCEPT;
      }
      case SYS.member:
        return f.action === 'remove' && f.user === user ? ACCEPT : owner ? ACCEPT : reject('role', 'Owner required');
      case SYS.device: {
        if (!(f.user === user || owner)) return reject('role', 'only your own devices');
        const pub = b64urlDecode(f.signPub);
        if ((await deviceIdFromSignPub(pub)) !== f.device) return reject('device-id-mismatch');
        const known = auth.activeDevices(f.user).map((d) => ({ id: d.id, signPub: b64urlDecode(d.signPub), agreePub: b64urlDecode(d.agreePub) }));
        const ok = await deps.verifyBinding(f.user, { id: f.device, signPub: pub, agreePub: b64urlDecode(f.agreePub) }, { kind: f.binding.kind, proof: b64urlDecode(f.binding.proof) }, known);
        return ok ? ACCEPT : reject('bad-binding');
      }
      case SYS.deviceRevoke: {
        const target = auth.device(f.device);
        return owner || (target && target.user === user) ? ACCEPT : target ? reject('role', 'only your own devices') : defer('unknown-device');
      }
      case SYS.invite:
      case SYS.inviteRevoke:
        return owner ? ACCEPT : reject('role', 'Owner required');
      case SYS.epoch:
        if (f.scope === env.space) return owner ? ACCEPT : reject('role', 'Owner required');
        if (!auth.share(f.scope)) return defer('unknown-share');
        return auth.shareCurrentRole(f.scope, user) === 'owner' ? ACCEPT : reject('role', 'share Owner required');
      case SYS.keygrant: {
        if (owner) return ACCEPT;
        const to = auth.device(f.to);
        if (to && to.user === user) return ACCEPT; // my own new device
        if (f.scope !== env.space && auth.share(f.scope) && auth.shareCurrentRole(f.scope, user) === 'owner') return ACCEPT;
        return reject('role', 'only Owners grant keys');
      }
      case SYS.share:
        return canWrite(role) ? ACCEPT : reject('role');
      case SYS.shareMember: {
        const s = auth.share(f.shareId);
        if (!s) return defer('unknown-share');
        const mine = auth.shareCurrentRole(f.shareId, user);
        return mine === 'owner' || (f.action === 'remove' && f.user === user) ? ACCEPT : reject('role', 'share Owner required');
      }
      default:
        void genesisBootstrap;
        void equalBytes;
        return ACCEPT; // an unknown $sys type from a newer version: keep and relay, never fold
    }
  }

  return {
    id: 'spaces/authority',
    phases: ['send', 'apply'],
    async validate(phase, env, body, ctx) {
      const r = await validate(phase, env, body, ctx);
      if (r.verdict === 'reject' && deps.report && !deps.quiet?.()) deps.report({ code: r.reason.split(':')[0] as RejectCode, id: env.id, space: env.space });
      return r;
    },
  };
}
