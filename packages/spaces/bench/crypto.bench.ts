// Micro-benchmarks for suite-1 (npm run bench -w @sync/spaces). The end-to-end numbers are in tests/perf/perf.test.ts.
import { bench, describe } from 'vitest';
import {
  aesOpen,
  aesSeal,
  generateAesKey,
  generateSignKeyPair,
  signBytes,
  verifySignature,
} from '../src/crypto/suite';

const msg = new Uint8Array(400).fill(7);
const nonce = new Uint8Array(12);
const aad = new Uint8Array(100);
const sign = await generateSignKeyPair();
const sig = await signBytes(sign.privateKey, msg);
const aes = await generateAesKey();
const sealed = await aesSeal(aes, nonce, msg, aad);

describe('suite-1', () => {
  bench('Ed25519 sign (400 B)', async () => void (await signBytes(sign.privateKey, msg)));
  bench('Ed25519 verify (400 B)', async () => void (await verifySignature(sign.publicRaw, sig, msg)));
  bench('AES-256-GCM seal (400 B)', async () => void (await aesSeal(aes, nonce, msg, aad)));
  bench('AES-256-GCM open (400 B)', async () => void (await aesOpen(aes, nonce, sealed, aad)));
});
