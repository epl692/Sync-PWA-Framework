// Generates keys.json and blobs.json from specs/004-blob-sync/contracts/blob-format.md using only node:crypto,
// independently of the production code. Run: node packages/blobs/tests/vectors/make-vectors.mjs
import { createCipheriv, createHash, createHmac, hkdfSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const CHUNK = 262144;
const hex = (b) => Buffer.from(b).toString('hex');
const sha = (b) => createHash('sha256').update(b).digest();
const b64url = (b) => Buffer.from(b).toString('base64url');
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };

// --- keys -------------------------------------------------------------------------------------------------
const epochKey = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
const scopeId = Buffer.from(Array.from({ length: 16 }, (_, i) => 0xa0 + i));
const keyId = sha(epochKey).subarray(0, 8);
const okm = Buffer.from(hkdfSync('sha256', epochKey, Buffer.alloc(32), Buffer.concat([Buffer.from('sync-blob/1'), scopeId, keyId]), 64));
const encKey = okm.subarray(0, 32);
const macKey = okm.subarray(32, 64);
writeFileSync(
  join(here, 'keys.json'),
  JSON.stringify({ epochKey: hex(epochKey), scopeId: hex(scopeId), keyId: hex(keyId), encKey: hex(encKey), macKey: hex(macKey), info: 'sync-blob/1 || scopeId(16) || keyId(8), salt = 32 zero bytes, L = 64' }, null, 2) + '\n',
);

// --- blobs ------------------------------------------------------------------------------------------------
const pattern = (size) => Buffer.from(Array.from({ length: size }, (_, i) => (i * 7 + 3) & 0xff));

function build(name, size, plain) {
  const n = Math.ceil(size / CHUNK);
  const chunks = [];
  const digests = [];
  for (let i = 0; i < n; i++) {
    const p = plain.subarray(i * CHUNK, Math.min(size, (i + 1) * CHUNK));
    const pd = sha(p);
    const nonce = createHmac('sha256', macKey).update(Buffer.concat([Buffer.from('n'), u32(i), pd])).digest().subarray(0, 12);
    const aad = Buffer.concat([Buffer.from([1]), scopeId, keyId, u64(size), u32(CHUNK), u32(i)]);
    const c = createCipheriv('aes-256-gcm', encKey, nonce);
    c.setAAD(aad);
    const ct = Buffer.concat([c.update(p), c.final(), c.getAuthTag()]);
    const stored = Buffer.concat([nonce, ct]);
    const d = sha(stored);
    digests.push(d);
    chunks.push({ index: i, plainLength: p.length, nonce: hex(nonce), storedLength: stored.length, storedSha256: hex(d), storedPrefix: hex(stored.subarray(0, 48)), ...(size <= 16 ? { stored: hex(stored) } : {}) });
  }
  const manifest = Buffer.concat([Buffer.from([1]), scopeId, keyId, u64(size), u32(CHUNK), u32(n), ...digests]);
  return { name, size, pattern: 'plain[i] = (i * 7 + 3) & 0xff', chunks, manifest: hex(manifest), id: b64url(sha(manifest)) };
}

const cases = [1, CHUNK, CHUNK + 1].map((size) => build(`size-${size}`, size, pattern(size)));
writeFileSync(join(here, 'blobs.json'), JSON.stringify({ chunkBytes: CHUNK, cases }, null, 2) + '\n');
console.log('wrote keys.json and blobs.json', cases.map((c) => c.id));
