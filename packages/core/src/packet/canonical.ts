/**
 * Canonical JSON (contracts/packet-envelope.md): UTF-8, object keys sorted at every level,
 * no insignificant whitespace, finite numbers only. Byte fields use unpadded base64url.
 */

export class CanonicalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalError';
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function write(v: unknown, out: string[]): void {
  if (v === null) return void out.push('null');
  switch (typeof v) {
    case 'boolean':
      return void out.push(v ? 'true' : 'false');
    case 'number':
      if (!Number.isFinite(v)) throw new CanonicalError('non-finite number');
      return void out.push(JSON.stringify(v));
    case 'string':
      return void out.push(JSON.stringify(v));
    case 'object': {
      if (Array.isArray(v)) {
        out.push('[');
        v.forEach((item, i) => {
          if (i) out.push(',');
          if (item === undefined) throw new CanonicalError('undefined array element');
          write(item, out);
        });
        out.push(']');
        return;
      }
      if (v instanceof Uint8Array) throw new CanonicalError('bytes must be base64url-encoded first');
      const keys = Object.keys(v as object).sort();
      out.push('{');
      let first = true;
      for (const k of keys) {
        const val = (v as Record<string, unknown>)[k];
        if (val === undefined) continue;
        if (!first) out.push(',');
        first = false;
        out.push(JSON.stringify(k), ':');
        write(val, out);
      }
      out.push('}');
      return;
    }
    default:
      throw new CanonicalError(`unsupported value of type ${typeof v}`);
  }
}

export function canonicalString(value: unknown): string {
  const out: string[] = [];
  write(value, out);
  return out.join('');
}

export function canonicalBytes(value: unknown): Uint8Array {
  return encoder.encode(canonicalString(value));
}

export function parseJsonBytes(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(decoder.decode(bytes));
  } catch (e) {
    throw new CanonicalError(`malformed JSON: ${(e as Error).message}`);
  }
}

export function b64urlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) throw new CanonicalError('invalid base64url');
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
