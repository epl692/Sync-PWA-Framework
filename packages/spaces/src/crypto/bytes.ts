/** Small byte helpers shared by the security code. */

export const utf8 = new TextEncoder();
export const utf8d = new TextDecoder();

/** Web Crypto's types want an ArrayBuffer-backed view; ours are always that. */
export const bs = (u: Uint8Array): BufferSource => u as unknown as BufferSource;

export function concat(...parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.byteLength;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}

export function u32be(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, false);
  return b;
}

export function readU32be(b: Uint8Array, off: number): number {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(off, false);
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let d = 0;
  for (let i = 0; i < a.byteLength; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}

export function hex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export function unhex(s: string): Uint8Array {
  if (s.length % 2 || /[^0-9a-f]/i.test(s)) throw new Error('bad hex');
  return Uint8Array.from(s.match(/../g) ?? [], (h) => parseInt(h, 16));
}

export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

export async function sha256(b: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bs(b)));
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Inverse of the 26-character base32 IDs of @sync/core (16 bytes). */
export function base32Decode(s: string): Uint8Array {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('bad base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}
