const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export type RandomBytes = (n: number) => Uint8Array;

export const cryptoRandomBytes: RandomBytes = (n) => {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
};

export function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** 128-bit random ID as 26 base32 characters. */
export function newId(random: RandomBytes = cryptoRandomBytes): string {
  return base32(random(16));
}

export const newDeviceId = newId;
export const newObjectId = newId;
