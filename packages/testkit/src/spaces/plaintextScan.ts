/**
 * Audit helper (SC-002): does any byte string, or anything encoded inside it, contain a plaintext marker?
 * Sync messages are JSON whose strings are base64url-encoded packets, whose bodies are base64url again,
 * so the scan looks through those layers too.
 */

import { b64urlDecode } from '@sync/core';

const dec = new TextDecoder('latin1');

function findIn(bytes: Uint8Array, markers: string[], depth: number, hits: Set<string>): void {
  const text = dec.decode(bytes);
  for (const m of markers) if (text.includes(m)) hits.add(m);
  if (depth <= 0) return;
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return;
  }
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      if (v.length >= 16 && /^[A-Za-z0-9_-]+$/.test(v)) {
        try {
          findIn(b64urlDecode(v), markers, depth - 1, hits);
        } catch {
          // not base64url after all
        }
      }
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(json);
}

/** The markers found anywhere in the given byte strings (empty when nothing leaks). */
export function scanForPlaintext(chunks: Iterable<Uint8Array>, markers: string[]): string[] {
  const hits = new Set<string>();
  for (const c of chunks) findIn(c, markers, 4, hits);
  return [...hits].sort();
}
