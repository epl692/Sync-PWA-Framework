/**
 * Serve and link codes (spec 005, contracts/hub-access.md). Text form: `syncserve:1:` + base64url(UTF-8 JSON).
 * A serve code carries only the access PUBLIC key. A link code also carries the access secret so one Hub can prove
 * membership to another Hub; it cannot decrypt anything.
 */

import { b64urlDecode, b64urlEncode } from './crypto/b64';
import { utf8, utf8d } from './crypto/bytes';

export const HUB_CODE_PREFIX = 'syncserve:1:';

export interface HubCode {
  v: 1;
  kind: 'serve' | 'link';
  /** Space ID (the same string the rest of the Framework uses). */
  space: string;
  epoch: number;
  accessPublic: Uint8Array;
  /** Present only when `kind === 'link'`. */
  accessSecret?: Uint8Array;
  name?: string;
  createdAt: number;
  expiresAt?: number;
}

export class HubCodeError extends Error {
  constructor(
    readonly code: 'malformed' | 'unsupported-version' | 'bad-length' | 'expired',
    message: string,
  ) {
    super(message);
  }
}

export function encodeHubCode(c: HubCode): string {
  const o: Record<string, unknown> = {
    v: 1,
    kind: c.kind,
    space: c.space,
    epoch: c.epoch,
    accessPublic: b64urlEncode(c.accessPublic),
    createdAt: c.createdAt,
  };
  if (c.kind === 'link') {
    if (!c.accessSecret) throw new HubCodeError('bad-length', 'a link code needs an access secret');
    o.accessSecret = b64urlEncode(c.accessSecret);
  }
  if (c.name !== undefined) o.name = c.name;
  if (c.expiresAt !== undefined) o.expiresAt = c.expiresAt;
  return HUB_CODE_PREFIX + b64urlEncode(utf8.encode(JSON.stringify(o)));
}

export function parseHubCode(text: string, now = Date.now()): HubCode {
  const t = text.trim();
  if (!t.startsWith('syncserve:')) throw new HubCodeError('malformed', 'not a serve code');
  if (!t.startsWith(HUB_CODE_PREFIX)) throw new HubCodeError('unsupported-version', 'unsupported serve code version');
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(utf8d.decode(b64urlDecode(t.slice(HUB_CODE_PREFIX.length)))) as Record<string, unknown>;
  } catch {
    throw new HubCodeError('malformed', 'unreadable serve code');
  }
  if (o.v !== 1) throw new HubCodeError('unsupported-version', 'unsupported serve code version');
  if (o.kind !== 'serve' && o.kind !== 'link') throw new HubCodeError('malformed', 'unknown code kind');
  if (typeof o.space !== 'string' || !o.space) throw new HubCodeError('malformed', 'missing Space');
  if (!Number.isInteger(o.epoch) || (o.epoch as number) < 0) throw new HubCodeError('malformed', 'bad epoch');
  if (typeof o.accessPublic !== 'string') throw new HubCodeError('malformed', 'missing access key');
  const accessPublic = b64urlDecode(o.accessPublic);
  if (accessPublic.byteLength !== 32) throw new HubCodeError('bad-length', 'access key must be 32 bytes');
  let accessSecret: Uint8Array | undefined;
  if (o.kind === 'link') {
    if (typeof o.accessSecret !== 'string') throw new HubCodeError('malformed', 'a link code needs an access secret');
    accessSecret = b64urlDecode(o.accessSecret);
    if (accessSecret.byteLength !== 32) throw new HubCodeError('bad-length', 'access secret must be 32 bytes');
  }
  const createdAt = typeof o.createdAt === 'number' ? o.createdAt : 0;
  const expiresAt = typeof o.expiresAt === 'number' ? o.expiresAt : undefined;
  if (expiresAt !== undefined && expiresAt <= now) throw new HubCodeError('expired', 'this serve code has expired');
  return {
    v: 1,
    kind: o.kind,
    space: o.space,
    epoch: o.epoch as number,
    accessPublic,
    ...(accessSecret ? { accessSecret } : {}),
    ...(typeof o.name === 'string' ? { name: o.name } : {}),
    createdAt,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  };
}
