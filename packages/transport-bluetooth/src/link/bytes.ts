/** Small byte helpers for the link codec (self-contained: no workspace dependency beyond the core). */

export const utf8 = new TextEncoder();
export const utf8d = new TextDecoder();
export const bs = (u: Uint8Array): BufferSource => u as unknown as BufferSource;

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function b64uEncode(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Null on any malformed input. */
export function b64uDecode(s: unknown): Uint8Array | null {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s)) return null;
  try {
    const t = s.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(t + '='.repeat((4 - (t.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}

export function u64be(n: number): Uint8Array {
  const out = new Uint8Array(8);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, Math.floor(n / 2 ** 32));
  dv.setUint32(4, n >>> 0);
  return out;
}

export function readU64be(b: Uint8Array, off = 0): number {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return dv.getUint32(off) * 2 ** 32 + dv.getUint32(off + 4);
}

export const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
