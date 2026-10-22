// T054: artifact encoding, the proof of the secret, the short authentication string, bindings, sealing and QR.
import { describe, expect, it } from 'vitest';
import { b64urlEncode } from '@sync/core';
import { FakeChannelNet, FakeHost } from '@sync/testkit';
import {
  deviceIdFromSignPub,
  generateAgreeKeyPair,
  generateSignKeyPair,
  utf8,
  type DevicePublic,
} from '@sync/spaces';
import {
  CHAIN_KIND,
  GENESIS_KIND,
  extendChain,
  issueGenesis,
  chainBinding,
  verifyDeviceBinding,
} from '../../src/binding';
import { decodeArtifact, encodeArtifact, proofOf, sasOf, type ArtifactData } from '../../src/invite';
import { openSealed, sealTo } from '../../src/seal';
import { qrMatrix, qrToSvg, canScanQr } from '../../src/qr';
import { WORDS } from '../../src/words';

async function artifact(over: Partial<ArtifactData> = {}): Promise<ArtifactData> {
  const sign = await generateSignKeyPair();
  const agree = await generateAgreeKeyPair();
  return {
    v: 1,
    i: 'INVITE1234567890',
    s: 'SPACEAAAAAAAAAAAAAAAAAAAAA',
    k: b64urlEncode(new Uint8Array(24).fill(7)),
    r: 'editor',
    e: 1_800_000_000_000,
    d: await deviceIdFromSignPub(sign.publicRaw),
    sp: b64urlEncode(sign.publicRaw),
    ap: b64urlEncode(agree.publicRaw),
    ...over,
  };
}

describe('invite artifact', () => {
  it('round trips through a link, a fragment and the bare payload', async () => {
    const a = await artifact();
    const { url, qrPayload } = encodeArtifact(a, 'https://app.example/');
    expect(url.startsWith('https://app.example/#/join/')).toBe(true);
    expect(qrPayload).toBe(url);
    expect(await decodeArtifact(url)).toEqual(a);
    expect(await decodeArtifact(url.slice(url.indexOf('#')))).toEqual(a);
    expect(await decodeArtifact(url.slice(url.indexOf('#/join/') + 7))).toEqual(a);
    expect(await decodeArtifact(`  ${url}\n`)).toEqual(a);
  });

  it('keeps the secret in the URL fragment, which a static host never receives', async () => {
    const a = await artifact();
    const { url } = encodeArtifact(a, 'https://app.example/path');
    const [beforeHash] = url.split('#');
    expect(beforeHash).toBe('https://app.example/path');
    expect(beforeHash).not.toContain(a.k);
  });

  it('refuses damaged input, a wrong version, a bad role, and an inviter ID that does not hash its key', async () => {
    const a = await artifact();
    for (const bad of [
      '',
      'nonsense',
      '#/join/',
      '#/join/!!!',
      encodeArtifact({ ...a, v: 2 as never }, 'x').url,
      encodeArtifact({ ...a, r: 'god' as never }, 'x').url,
      encodeArtifact({ ...a, d: 'SOMEONEELSE' }, 'x').url,
      encodeArtifact({ ...a, sp: 'AAAA' }, 'x').url,
    ]) {
      expect(await decodeArtifact(bad), bad).toBeUndefined();
    }
  });

  it('fits a QR code', async () => {
    const { qrPayload } = encodeArtifact(await artifact(), 'https://app.example/');
    const m = qrMatrix(qrPayload);
    expect(m.length).toBeGreaterThan(20);
    expect(m.length).toBeLessThan(120);
    const svg = qrToSvg(qrPayload);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('viewBox');
    expect(canScanQr()).toBe(false); // Node has no BarcodeDetector: the app falls back to a pasted link
  });
});

describe('proof of the secret', () => {
  it('is an HMAC of the joiner key and nonce: it changes with each, and not with the wrong secret', async () => {
    const secret = new Uint8Array(24).fill(1);
    const key = crypto.getRandomValues(new Uint8Array(32));
    const n1 = crypto.getRandomValues(new Uint8Array(16));
    const n2 = crypto.getRandomValues(new Uint8Array(16));
    const p = await proofOf(secret, key, n1);
    expect(p).toHaveLength(32);
    expect(await proofOf(secret, key, n1)).toEqual(p);
    expect(await proofOf(secret, key, n2)).not.toEqual(p);
    expect(await proofOf(secret, crypto.getRandomValues(new Uint8Array(32)), n1)).not.toEqual(p);
    expect(await proofOf(new Uint8Array(24).fill(2), key, n1)).not.toEqual(p);
  });
});

describe('short authentication string', () => {
  it('is five distinct-looking words, equal on both screens, different for different keys', async () => {
    expect(WORDS).toHaveLength(256);
    expect(new Set(WORDS).size).toBe(256);
    const a = crypto.getRandomValues(new Uint8Array(32));
    const b = crypto.getRandomValues(new Uint8Array(32));
    const sas = await sasOf(a, b);
    expect(sas.split('-')).toHaveLength(5);
    expect(await sasOf(a, b)).toBe(sas);
    expect(await sasOf(b, a)).not.toBe(sas);
    expect(await sasOf(crypto.getRandomValues(new Uint8Array(32)), b)).not.toBe(sas);
  });
});

describe('device bindings', () => {
  async function devices(n: number) {
    const net = new FakeChannelNet();
    return Promise.all(Array.from({ length: n }, (_, i) => FakeHost.create(`d${i}`, net)));
  }
  const pub = (h: FakeHost): DevicePublic => h.publicDevice;

  it('a first device proves itself with a self-signature; its user is its device ID', async () => {
    const [a, b] = await devices(2);
    const g = await issueGenesis(a!.device);
    expect(g.kind).toBe(GENESIS_KIND);
    expect(await verifyDeviceBinding(a!.device.deviceId, pub(a!), g)).toBe(true);
    expect(await verifyDeviceBinding('another-user', pub(a!), g)).toBe(false);
    expect(await verifyDeviceBinding(a!.device.deviceId, pub(b!), g)).toBe(false);
  });

  it('later devices are bound by a chain of signatures back to the first device, checked from the evidence alone', async () => {
    const [a, b, c] = await devices(3);
    const user = a!.device.deviceId;
    const toB = await extendChain(user, a!.device, undefined, pub(b!));
    expect(await verifyDeviceBinding(user, pub(b!), chainBinding(toB))).toBe(true);
    const toC = await extendChain(user, b!.device, toB, pub(c!));
    expect(toC.links).toHaveLength(2);
    expect(await verifyDeviceBinding(user, pub(c!), chainBinding(toC))).toBe(true);
    expect(chainBinding(toC).kind).toBe(CHAIN_KIND);
    // wrong device, wrong user, root swapped for someone else's key
    expect(await verifyDeviceBinding(user, pub(b!), chainBinding(toC))).toBe(false);
    expect(await verifyDeviceBinding(b!.device.deviceId, pub(c!), chainBinding(toC))).toBe(false);
    const stranger = (await devices(1))[0]!;
    expect(
      await verifyDeviceBinding(
        user,
        pub(c!),
        chainBinding({
          ...toC,
          root: { signPub: b64urlEncode(stranger.device.signPub), agreePub: toC.root.agreePub },
        }),
      ),
    ).toBe(false);
  });

  it('a forged or truncated link, or a link skipping a device, does not verify', async () => {
    const [a, b, c] = await devices(3);
    const user = a!.device.deviceId;
    const toB = await extendChain(user, a!.device, undefined, pub(b!));
    const toC = await extendChain(user, b!.device, toB, pub(c!));
    const forged = {
      ...toC,
      links: toC.links.map((l, i) => (i === 1 ? { ...l, sig: toC.links[0]!.sig } : l)),
    };
    expect(await verifyDeviceBinding(user, pub(c!), chainBinding(forged))).toBe(false);
    expect(
      await verifyDeviceBinding(user, pub(c!), chainBinding({ ...toC, links: toC.links.slice(1) })),
    ).toBe(false);
    expect(await verifyDeviceBinding(user, pub(c!), chainBinding({ ...toC, links: [] }))).toBe(false);
  });

  it('is a total function: garbage evidence is false and never throws', async () => {
    const [a] = await devices(1);
    for (const proof of [
      new Uint8Array(),
      utf8.encode('{'),
      utf8.encode('{"root":1,"links":[{}]}'),
      crypto.getRandomValues(new Uint8Array(200)),
    ]) {
      expect(await verifyDeviceBinding(a!.device.deviceId, pub(a!), { kind: CHAIN_KIND, proof })).toBe(false);
      expect(await verifyDeviceBinding(a!.device.deviceId, pub(a!), { kind: GENESIS_KIND, proof })).toBe(
        false,
      );
    }
    expect(await verifyDeviceBinding('u', pub(a!), { kind: 'weird/9', proof: new Uint8Array() })).toBe(false);
  });
});

describe('sealed messages', () => {
  it('only the addressed device can open them, and only in the right context', async () => {
    const net = new FakeChannelNet();
    const a = await FakeHost.create('a', net);
    const b = await FakeHost.create('b', net);
    const sealed = await sealTo(a.device.agreePub, utf8.encode('hello'), 'join-request');
    expect(new TextDecoder().decode((await openSealed(a.device, sealed, 'join-request'))!)).toBe('hello');
    expect(await openSealed(b.device, sealed, 'join-request')).toBeNull(); // another device
    expect(await openSealed(a.device, sealed, 'join-reply')).toBeNull(); // a reply cannot be replayed as a request
    const flipped = sealed.slice();
    flipped[flipped.length - 1]! ^= 1;
    expect(await openSealed(a.device, flipped, 'join-request')).toBeNull();
    expect(await openSealed(a.device, sealed.slice(0, 20), 'join-request')).toBeNull();
    expect(new TextDecoder('latin1').decode(sealed)).not.toContain('hello');
  });

  it('uses a fresh ephemeral key each time', async () => {
    const net = new FakeChannelNet();
    const a = await FakeHost.create('a', net);
    const s1 = await sealTo(a.device.agreePub, utf8.encode('x'), 'c');
    const s2 = await sealTo(a.device.agreePub, utf8.encode('x'), 'c');
    expect(s1.slice(1, 33)).not.toEqual(s2.slice(1, 33));
  });
});
