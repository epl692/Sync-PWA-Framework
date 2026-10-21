/** Shape checks for `$sys.*` bodies. Used by the validators at ingest; the fold itself is lenient. */

import { SYS, isRole, isSysType, type SysType } from './types';

const isStr = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length < 4096;
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isId = (x: unknown): x is string => typeof x === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(x);
const isHex16 = (x: unknown): x is string => typeof x === 'string' && /^[0-9a-f]{16}$/.test(x);
const isB64 = (x: unknown, bytes?: number): x is string => typeof x === 'string' && /^[A-Za-z0-9_-]*$/.test(x) && (bytes === undefined || Math.ceil((x.length * 3) / 4) >= bytes - 1 && x.length <= Math.ceil((bytes * 4) / 3) + 1);
const isSeq = (x: unknown): x is number => Number.isInteger(x) && (x as number) >= 0 && (x as number) < 2 ** 40;
const isCutoffMap = (x: unknown): boolean => x === undefined || (isObj(x) && Object.entries(x).every(([k, v]) => isId(k) && isSeq(v)));

function checkMembers(m: unknown): boolean {
  return Array.isArray(m) && m.length >= 1 && m.length <= 200 && m.every((e) => isObj(e) && isId(e.user) && isRole(e.role));
}

/** A description of the first problem, or undefined when the fields are well formed. Unknown `$sys.*` types pass. */
export function checkFields(type: string, f: unknown): string | undefined {
  if (!isSysType(type)) return undefined;
  if (!isObj(f)) return 'fields must be an object';
  const t: SysType = type;
  switch (t) {
    case SYS.genesis: {
      const o = f.owner;
      if (!isObj(o) || !isId(o.user) || !isId(o.device) || !isB64(o.signPub, 32) || !isB64(o.agreePub, 32)) return 'bad owner';
      if (!isObj(o.binding) || !isStr(o.binding.kind) || typeof o.binding.proof !== 'string') return 'bad owner binding';
      if (!isB64(f.nonce)) return 'bad nonce';
      return f.name !== undefined && !isStr(f.name) ? 'bad name' : undefined;
    }
    case SYS.member:
      if (!['add', 'role', 'remove'].includes(f.action as string) || !isId(f.user)) return 'bad member action';
      if (f.action !== 'remove' && !isRole(f.role)) return 'bad role';
      if (f.inviteId !== undefined && !isId(f.inviteId)) return 'bad inviteId';
      return isCutoffMap(f.cutoff) ? undefined : 'bad cutoff';
    case SYS.device:
      if (!isId(f.user) || !isId(f.device) || !isB64(f.signPub, 32) || !isB64(f.agreePub, 32)) return 'bad device';
      return isObj(f.binding) && isStr(f.binding.kind) && typeof f.binding.proof === 'string' ? undefined : 'bad binding';
    case SYS.deviceRevoke:
      return isId(f.device) && isSeq(f.cutoff) ? undefined : 'bad revoke';
    case SYS.invite:
      return isId(f.inviteId) && isRole(f.role) && Number.isInteger(f.expiresAt) && Number.isInteger(f.maxUses) && (f.maxUses as number) >= 1 && isB64(f.secretHash) && (f.approval === 'required' || f.approval === 'auto')
        ? undefined
        : 'bad invite';
    case SYS.inviteRevoke:
      return isId(f.inviteId) ? undefined : 'bad invite revoke';
    case SYS.epoch:
      return isId(f.scope) && isSeq(f.epoch) && isHex16(f.keyId) && (f.prevKeyId === undefined || isHex16(f.prevKeyId)) ? undefined : 'bad epoch';
    case SYS.keygrant:
      if (!isId(f.to) || !isId(f.scope) || !isB64(f.eph, 32) || !Array.isArray(f.items) || f.items.length < 1 || f.items.length > 256) return 'bad grant';
      return f.items.every((i) => isObj(i) && isSeq(i.epoch) && isHex16(i.keyId) && isB64(i.nonce, 12) && isB64(i.wrapped)) ? undefined : 'bad grant item';
    case SYS.share:
      return isId(f.shareId) && isId(f.obj) && checkMembers(f.members) ? undefined : 'bad share';
    case SYS.shareMember:
      if (!isId(f.shareId) || !isId(f.user) || !['add', 'role', 'remove'].includes(f.action as string)) return 'bad share member';
      if (f.action !== 'remove' && !isRole(f.role)) return 'bad role';
      return isCutoffMap(f.cutoff) ? undefined : 'bad cutoff';
  }
}
