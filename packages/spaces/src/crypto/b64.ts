import { b64urlDecode, b64urlEncode } from '@sync/core';

export { b64urlEncode };
export { b64urlDecode };

/** Undefined instead of throwing. */
export function b64urlDecodeSafe(s: string): Uint8Array | undefined {
  try {
    return b64urlDecode(s);
  } catch {
    return undefined;
  }
}
