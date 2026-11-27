// Spec 005 S-2: Hub access key derivation, known-answer vectors, and the "cannot decrypt" properties.
// Vectors were computed independently (Python `cryptography`: HKDF-SHA-256 and Ed25519), not with this code.
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  HUB_ACCESS_LABEL,
  HUB_AUTH_LABEL,
  deriveHubAccess,
  hubAuthMessage,
  proveHubChallenge,
  verifyHubProof,
} from '../../src/hubAccess';
import { hex, unhex, utf8 } from '../../src/crypto/bytes';
import { hkdf } from '../../src/crypto/suite';

const epochKey = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const spaceId = Uint8Array.from({ length: 16 }, (_, i) => 0xa0 + i);
const fp = new Uint8Array(32).fill(0x55);
const nc = new Uint8Array(16).fill(0x11);
const nh = new Uint8Array(16).fill(0x22);

const V = {
  pub: '24484ec8b8a92a76faf4f35e69af731dc473a17e52ad7f25b11812e99e97bf7a',
  seed: 'd65ded2b82f36cc48dbb275dfe7561cfafd2b9eac873a96ccf36eea5e7f9940e',
  sig: '4fb96f8a5195cd0d8dc9fd7aea940f2530d8cd7c8501dc37b23dd65e7ef5be6a627d8cc9674d713fe06fcc6345c16dfca88eb7ee759b0b5fba272613d1741106',
};

describe('hub access key', () => {
  it('uses the documented labels', () => {
    expect(HUB_ACCESS_LABEL).toBe('sync-hub-access/1');
    expect(HUB_AUTH_LABEL).toBe('sync-hub-auth/1');
  });

  it('matches the known-answer vectors', async () => {
    const a = await deriveHubAccess(epochKey, spaceId, 4);
    expect(hex(a.seed)).toBe(V.seed);
    expect(hex(a.publicRaw)).toBe(V.pub);
    const msg = hubAuthMessage({ hubFingerprint: fp, nc, nh, space: spaceId, epoch: 4 });
    const sig = await proveHubChallenge(a, msg);
    expect(hex(sig)).toBe(V.sig);
    expect(await verifyHubProof(unhex(V.pub), sig, msg)).toBe(true);
  });

  it('is deterministic, and differs by epoch and by Space', async () => {
    const a = await deriveHubAccess(epochKey, spaceId, 4);
    const b = await deriveHubAccess(epochKey, spaceId, 4);
    expect(hex(a.publicRaw)).toBe(hex(b.publicRaw));
    expect(hex((await deriveHubAccess(epochKey, spaceId, 5)).publicRaw)).not.toBe(hex(a.publicRaw));
    const other = spaceId.slice();
    other[0] ^= 1;
    expect(hex((await deriveHubAccess(epochKey, other, 4)).publicRaw)).not.toBe(hex(a.publicRaw));
  });

  it('a proof is bound to the Hub, both nonces, the Space and the epoch', async () => {
    const a = await deriveHubAccess(epochKey, spaceId, 4);
    const base = { hubFingerprint: fp, nc, nh, space: spaceId, epoch: 4 };
    const sig = await proveHubChallenge(a, hubAuthMessage(base));
    const flip = (u: Uint8Array) => {
      const c = u.slice();
      c[0] ^= 1;
      return c;
    };
    for (const bad of [
      { ...base, hubFingerprint: flip(fp) },
      { ...base, nc: flip(nc) },
      { ...base, nh: flip(nh) },
      { ...base, space: flip(spaceId) },
      { ...base, epoch: 5 },
    ]) {
      expect(await verifyHubProof(a.publicRaw, sig, hubAuthMessage(bad))).toBe(false);
    }
  });

  it('never equals a key derived by the other 002 and 004 labels (domain separation)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ minLength: 32, maxLength: 32 }),
        fc.uint8Array({ minLength: 16, maxLength: 16 }),
        fc.integer({ min: 0, max: 1000 }),
        async (k, sid, epoch) => {
          const a = await deriveHubAccess(k, sid, epoch);
          const epochBytes = new Uint8Array(4);
          new DataView(epochBytes.buffer).setUint32(0, epoch);
          for (const label of ['sync-blob/1', 'sync-grant/1', 'aes-gcm-space/1']) {
            const other = await hkdf(k, new Uint8Array(32), new Uint8Array([...utf8.encode(label), ...sid, ...epochBytes]), 32);
            expect(hex(other)).not.toBe(hex(a.seed));
          }
          // the access seed does not reveal the epoch key
          expect(hex(a.seed)).not.toBe(hex(k));
          expect(hex(a.publicRaw)).not.toBe(hex(k));
        },
      ),
      { numRuns: 25 },
    );
  });

  it('verifyHubProof never throws on junk', async () => {
    expect(await verifyHubProof(new Uint8Array(3), new Uint8Array(64), new Uint8Array(1))).toBe(false);
    expect(await verifyHubProof(unhex(V.pub), new Uint8Array(10), new Uint8Array(1))).toBe(false);
  });
});
