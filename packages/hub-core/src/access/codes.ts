/** Serve and link code import (specs/005-bluetooth-transport/contracts/hub-access.md). Same text format as the Spaces layer's `exportHubCode`. */

import { b64uDecode } from '@sync/transport-bluetooth/link';
import type { ServedSpaceRecord } from '../types';

export const DAY_MS = 86_400_000;
const PREFIX = 'syncserve:1:';

export class ServeCodeError extends Error {
  constructor(
    readonly code: 'malformed' | 'unsupported-version' | 'bad-length' | 'expired',
    message: string,
  ) {
    super(message);
  }
}

export interface ParsedCode {
  kind: 'serve' | 'link';
  space: string;
  epoch: number;
  accessPublic: Uint8Array;
  accessSecret?: Uint8Array;
  name?: string;
  createdAt: number;
  expiresAt?: number;
}

export function parseServeCode(text: string, now: number): ParsedCode {
  const t = text.trim();
  if (!t.startsWith('syncserve:')) throw new ServeCodeError('malformed', 'not a serve code');
  if (!t.startsWith(PREFIX)) throw new ServeCodeError('unsupported-version', 'unsupported serve code version');
  const raw = b64uDecode(t.slice(PREFIX.length));
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(new TextDecoder().decode(raw ?? new Uint8Array())) as Record<string, unknown>;
  } catch {
    throw new ServeCodeError('malformed', 'unreadable serve code');
  }
  if (!o || typeof o !== 'object') throw new ServeCodeError('malformed', 'unreadable serve code');
  if (o.v !== 1) throw new ServeCodeError('unsupported-version', 'unsupported serve code version');
  if (o.kind !== 'serve' && o.kind !== 'link') throw new ServeCodeError('malformed', 'unknown code kind');
  if (typeof o.space !== 'string' || !/^[A-Z2-7]{26}$/.test(o.space)) throw new ServeCodeError('malformed', 'bad Space ID');
  if (!Number.isInteger(o.epoch) || (o.epoch as number) < 0) throw new ServeCodeError('malformed', 'bad epoch');
  const accessPublic = b64uDecode(o.accessPublic);
  if (!accessPublic || accessPublic.length !== 32) throw new ServeCodeError('bad-length', 'access key must be 32 bytes');
  let accessSecret: Uint8Array | undefined;
  if (o.kind === 'link') {
    accessSecret = b64uDecode(o.accessSecret) ?? undefined;
    if (!accessSecret || accessSecret.length !== 32) throw new ServeCodeError('bad-length', 'a link code needs a 32-byte access secret');
  }
  const expiresAt = typeof o.expiresAt === 'number' ? o.expiresAt : undefined;
  if (expiresAt !== undefined && expiresAt <= now) throw new ServeCodeError('expired', 'this serve code has expired');
  return {
    kind: o.kind,
    space: o.space,
    epoch: o.epoch as number,
    accessPublic,
    ...(accessSecret ? { accessSecret } : {}),
    ...(typeof o.name === 'string' ? { name: o.name.slice(0, 64) } : {}),
    createdAt: typeof o.createdAt === 'number' ? o.createdAt : 0,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  };
}

/**
 * Register a code's access key for its Space. A newer epoch adds its key and gives older keys `expiresAt = now + retentionDays`
 * (so lagging clients still sync, then the old key stops working). A serve code never removes a link code's secret.
 */
export function applyServeCode(existing: ServedSpaceRecord | undefined, code: ParsedCode, now: number, retentionDays: number): ServedSpaceRecord {
  const rec: ServedSpaceRecord = existing
    ? structuredClone(existing)
    : { space: code.space, source: 'code', accessKeys: [], addedAt: now, ...(code.name ? { name: code.name } : {}) };
  rec.source = 'code';
  if (code.name) rec.name = code.name;
  const highest = rec.accessKeys.reduce((m, k) => Math.max(m, k.epoch), -1);
  const have = rec.accessKeys.find((k) => k.epoch === code.epoch);
  if (!have) rec.accessKeys.push({ epoch: code.epoch, publicKey: code.accessPublic.slice(), addedAt: now });
  else if (have.publicKey.length === code.accessPublic.length && have.publicKey.some((b, i) => b !== code.accessPublic[i])) {
    have.publicKey = code.accessPublic.slice(); // the owner re-exported: the newest code wins
  }
  const newest = Math.max(highest, code.epoch);
  for (const k of rec.accessKeys) {
    if (k.epoch < newest && k.expiresAt === undefined) k.expiresAt = now + retentionDays * DAY_MS;
    if (k.epoch === newest) delete k.expiresAt;
  }
  if (code.accessSecret) rec.accessSecret = code.accessSecret.slice();
  rec.accessKeys.sort((a, b) => b.epoch - a.epoch);
  return rec;
}

/** Drop access keys whose `expiresAt` has passed. Returns true if anything was removed. */
export function pruneExpiredKeys(rec: ServedSpaceRecord, now: number): boolean {
  const before = rec.accessKeys.length;
  rec.accessKeys = rec.accessKeys.filter((k) => k.expiresAt === undefined || k.expiresAt > now);
  return rec.accessKeys.length !== before;
}
