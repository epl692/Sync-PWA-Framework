// Spec 005 S-2 in a real Space: members derive the same access key, outsiders cannot, and rotation changes the key.
import { describe, expect, it } from 'vitest';
import { hubAuthMessage, parseHubCode, verifyHubProof, base32Decode, hex } from '../../src';
import { buildFamily, settle } from '../family';

const fp = new Uint8Array(32).fill(3);
const nc = new Uint8Array(16).fill(4);
const nh = new Uint8Array(16).fill(5);

describe('S-2 hub access in a real Space', () => {
  it('a member exports a serve code (public key only) and any member proves against it', async () => {
    const f = await buildFamily();
    const text = await f.owner.spaces.hubAccess.exportCode(f.space.id, { name: false });
    const code = parseHubCode(text);
    expect(code.kind).toBe('serve');
    expect(code.accessSecret).toBeUndefined();
    expect(text).not.toContain('accessSecret');

    for (const n of [f.owner, f.editor, f.viewer]) {
      const sig = await n.spaces.hubAccess.proofs.proveSpace({ space: f.space.id, epoch: code.epoch, hubFingerprint: fp, nc, nh });
      const msg = hubAuthMessage({ hubFingerprint: fp, nc, nh, space: base32Decode(f.space.id), epoch: code.epoch });
      expect(await verifyHubProof(code.accessPublic, sig, msg)).toBe(true);
    }
    await f.g.close();
  });

  it('a link code carries the secret, and a device outside the Space cannot prove or export', async () => {
    const f = await buildFamily({ extra: ['stranger'] });
    const link = parseHubCode(await f.owner.spaces.hubAccess.exportCode(f.space.id, { link: true }));
    expect(link.kind).toBe('link');
    expect(link.accessSecret?.byteLength).toBe(32);

    const stranger = f.g.node('stranger');
    await stranger.spaces.signUp('s');
    await expect(stranger.spaces.hubAccess.exportCode(f.space.id)).rejects.toThrow();
    await expect(stranger.spaces.hubAccess.proofs.proveSpace({ space: f.space.id, epoch: link.epoch, hubFingerprint: fp, nc, nh })).rejects.toThrow();
    expect(await stranger.spaces.hubAccess.proofs.spaces()).toEqual([]);
    await f.g.close();
  });

  it('after a removal rotates the epoch the access key changes, and the removed member cannot derive the new one', async () => {
    const f = await buildFamily();
    const before = parseHubCode(await f.owner.spaces.hubAccess.exportCode(f.space.id));
    await f.owner.spaces.remove(f.space.id, f.viewer.spaces.session()!.user);
    await settle(f.g, 6);
    const after = parseHubCode(await f.owner.spaces.hubAccess.exportCode(f.space.id));
    expect(after.epoch).toBeGreaterThan(before.epoch);
    expect(hex(after.accessPublic)).not.toBe(hex(before.accessPublic));
    // the removed viewer still proves the OLD epoch (documented residual risk RK-2) but has no key for the new one
    await expect(f.viewer.spaces.hubAccess.proofs.proveSpace({ space: f.space.id, epoch: after.epoch, hubFingerprint: fp, nc, nh })).rejects.toThrow();
    await expect(f.viewer.spaces.hubAccess.proofs.proveSpace({ space: f.space.id, epoch: before.epoch, hubFingerprint: fp, nc, nh })).resolves.toBeDefined();
    await f.g.close();
  });

  it('proveDevice binds the session to the device key', async () => {
    const f = await buildFamily();
    const p = await f.editor.spaces.hubAccess.proofs.proveDevice({ hubFingerprint: fp, nc, nh });
    expect(p.device).toBeTruthy();
    expect(p.sig.byteLength).toBe(64);
    await f.g.close();
  });
});
