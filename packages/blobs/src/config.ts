/** Resolved configuration: defaults from contracts/blobs-api.ts, with the limits checked once at startup. */

import { ABSOLUTE_MAX_BLOB_BYTES, DEFAULT_MAX_BLOB_BYTES } from './format/constants';
import type { BlobRef } from './format/ref';
import type { BlobsConfig } from './types';

const DAY = 24 * 60 * 60 * 1000;

export interface ResolvedConfig {
  maxBlobBytes: number;
  budgetBytes: number | undefined;
  minReplicas: number;
  evictOnQuota: boolean;
  retentionMs: number;
  orphanGraceMs: number;
  prefetch: ((ref: BlobRef) => boolean) | undefined;
  maxSources: number;
  /** Explicit window, or undefined to use 8 (32 on bulk transports) per peer. */
  window: number | undefined;
  serve: boolean;
  requestTimeoutMs: number;
  now: () => number;
}

export function resolveConfig(c: BlobsConfig = {}): ResolvedConfig {
  const maxBlobBytes = c.maxBlobBytes ?? DEFAULT_MAX_BLOB_BYTES;
  if (!Number.isSafeInteger(maxBlobBytes) || maxBlobBytes <= 0 || maxBlobBytes > ABSOLUTE_MAX_BLOB_BYTES) {
    throw new RangeError(`maxBlobBytes must be between 1 and ${ABSOLUTE_MAX_BLOB_BYTES} bytes`);
  }
  const positive = (v: number | undefined, def: number, name: string): number => {
    const x = v ?? def;
    if (!Number.isFinite(x) || x < 0) throw new RangeError(`${name} must not be negative`);
    return x;
  };
  return {
    maxBlobBytes,
    budgetBytes: c.budgetBytes,
    minReplicas: Math.max(0, Math.floor(positive(c.minReplicas, 1, 'minReplicas'))),
    evictOnQuota: c.evictOnQuota ?? false,
    retentionMs: positive(c.retentionMs, 30 * DAY, 'retentionMs'),
    orphanGraceMs: positive(c.orphanGraceMs, DAY, 'orphanGraceMs'),
    prefetch: c.prefetch,
    maxSources: Math.max(1, Math.floor(c.maxSources ?? 2)),
    window: c.window === undefined ? undefined : Math.max(1, Math.floor(c.window)),
    serve: c.serve ?? true,
    requestTimeoutMs: Math.max(1, positive(c.requestTimeoutMs, 30_000, 'requestTimeoutMs')),
    now: c.now ?? (() => Date.now()),
  };
}

/** Outstanding chunk messages a peer may have toward us: explicit, else 8 (32 when the transport has a bulk channel). */
export const windowFor = (cfg: ResolvedConfig, bulk: boolean): number => cfg.window ?? (bulk ? 32 : 8);
