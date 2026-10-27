// T057 (SC-003, US2.4): what a relay stores and sees of an attachment is ciphertext. Real secure devices, a real
// RelayHub with the blob relay on a real directory.
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HubNetwork, createSecureNode, scanForPlaintext, waitFor } from '@sync/testkit';
import { BlobRelay, createFileBlobStorage } from '@sync/relay-server';
import { createBlobs, createMemoryBlobStorage } from '../../src';

const MARKER = 'MRK-BLOB-PLAINTEXT-7c1e';
const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await filesUnder(p)));
    else out.push(p);
  }
  return out;
}

describe('the relay holds ciphertext only', () => {
  it('never sees or stores the plaintext of an attachment, and a second device still decrypts it from the relay alone', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'blob-plain-'));
    dirs.push(dir);
    const net = new HubNetwork();
    const storage = await createFileBlobStorage(dir);
    const relay = new BlobRelay(net.hub, { storage, onError: () => undefined });

    const a = await createSecureNode({ name: 'a' });
    const b = await createSecureNode({ name: 'b', clock: a.clock });
    const ta = net.transport('a');
    a.core.addTransport(ta);
    b.core.addTransport(net.transport('b'));
    const space = await a.spaces.create('Photos');
    const art = await a.spaces.invite(space.id, { role: 'editor', expiresAt: a.clock.now() + 3_600_000, maxUses: 1, approval: 'auto' });
    await b.spaces.accept(art.url);

    const A = await createBlobs({ core: a.core, keys: a.spaces.blobKeys, storage: createMemoryBlobStorage() });
    const B = await createBlobs({ core: b.core, keys: b.spaces.blobKeys, storage: createMemoryBlobStorage() });
    const plain = new TextEncoder().encode((MARKER + ' ').repeat(12_000)); // about 280 KB: two chunks
    const ref = await A.attach(new Blob([plain as BlobPart]), { space: space.id, obj: 'photo-1' });
    await waitFor(async () => (await storage.getBlob(ref.id))?.complete === true, 15_000, 'the relay stored the blob');

    // 1. every byte that crossed the relay, in either direction, lane messages included
    expect(scanForPlaintext(net.everything(), [MARKER])).toEqual([]);
    // 2. every file the relay wrote
    for (const f of await filesUnder(dir)) expect(new TextDecoder('latin1').decode(await readFile(f)).includes(MARKER), f).toBe(false);
    // 3. the scan does see the marker when it is there
    expect(scanForPlaintext([plain], [MARKER])).toEqual([MARKER]);
    expect(net.seen.some((m) => m[0] === 0xb1)).toBe(true); // lane traffic really went through the relay

    // the relay holds no key: the module that stores blobs never imports the spaces package (release-surface test), and the
    // second device, with the first one gone, reads the attachment from the relay alone
    ta.setOnline(false);
    await waitFor(() => b.core.peers().some((p) => p.lanes.length && p.spaces.includes('*')), 15_000, 'b sees the relay');
    await B.request(ref);
    const got = new Uint8Array(await (await B.toBlob(ref)).arrayBuffer());
    expect(got.length).toBe(plain.length);
    expect(got.every((v, i) => v === plain[i])).toBe(true);
    relay.close();
    await A.close();
    await B.close();
  }, 120_000);
});
