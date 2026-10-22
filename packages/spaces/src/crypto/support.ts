import { generateAgreeKeyPair, generateSignKeyPair } from './suite';

export type Support = { ok: true } | { ok: false; reason: string };

/** Can this environment run suite-1? The security layer refuses to start otherwise (no plaintext fallback). */
export async function detectSupport(): Promise<Support> {
  try {
    if (!globalThis.crypto?.subtle) return { ok: false, reason: 'Web Crypto is not available' };
    await generateSignKeyPair();
  } catch {
    return { ok: false, reason: 'Ed25519 is not supported by this browser' };
  }
  try {
    await generateAgreeKeyPair();
  } catch {
    return { ok: false, reason: 'X25519 is not supported by this browser' };
  }
  return { ok: true };
}
