// Spec 005 link/1 handshake and session crypto. Vectors computed independently with Python `cryptography`
// (X25519, Ed25519, HKDF-SHA-256, AES-GCM), using fixed private keys: hub seed 0x07*32, client X25519 0x01*32, hub X25519 0x02*32.
import { describe, expect, it } from 'vitest';
import {
  LinkError,
  LinkSession,
  Kind,
  acceptHello,
  ackSigInput,
  busyAck,
  decodeInner,
  deriveSessionKeys,
  encodeControl,
  encodeCore,
  fingerprintBytes,
  startClientHandshake,
} from '../../src/link';

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (s: string) => Uint8Array.from(s.match(/../g)!.map((h) => parseInt(h, 16)));

const V = {
  hubPub: 'ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c',
  fp: 'fe812c12f3ab4ce6ac5db69ac352f906cb1b11ef43fb33e252ef7ff552263889',
  cpub: 'a4e09292b651c278b9772c569f5fa9bb13d906b46ab68c9df9dc2b4409f8a209',
  hpub: 'ce8d3ad1ccb633ec7b70c17814a5c76ecd029685050d344745ba05870e587d59',
  shared: '2ed76ab549b1e73c031eb49c9448f0798aea81b698279a0c3dc3e49fbfc4b953',
  sig: '234820162579e9155fad588ce04cc6c32396d01ecbf6a318fe3c72c6ff3112344a7b1ac6d30d7b4070fda722c7f37a49b2d586ceb252139dc3a00b7364c4cf0d',
  c2h: '3e55f70f2cf2b0eeb1d4335a894db7b6cccd39fdcf95aaeb6d22ec3344130d9f',
  h2c: '70c7e92dc52071353003924478a2246d7cbf2d6f98da9e542c13c975a69c7b84',
  sealedC2h1: 'e00000000000000001e2e79c326fbd84becd71cf837ef336bce0f4a5b4eb4a214604637fcc0c',
  sealedH2c5: 'e000000000000000055de3ed0195feec0e4448d7b6236fc36ad9e32c6615e1d55e97b730ec2b',
};
const nc = new Uint8Array(16).fill(0x11);
const nh = new Uint8Array(16).fill(0x22);

async function hubIdentity(seedByte = 7) {
  const seed = new Uint8Array(32).fill(seedByte);
  const pkcs8 = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20, ...seed]);
  const priv = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, true, ['sign']);
  const jwk = await crypto.subtle.exportKey('jwk', priv);
  const pub = Uint8Array.from(atob(jwk.x!.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  return { publicKey: pub, sign: async (m: Uint8Array) => new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, priv, m)) };
}

describe('known-answer vectors', () => {
  it('fingerprint is SHA-256 of the Hub public key', async () => {
    expect(hex(await fingerprintBytes(unhex(V.hubPub)))).toBe(V.fp);
  });

  it('hello-ack signature input and Ed25519 signature', async () => {
    const hub = await hubIdentity();
    expect(hex(hub.publicKey)).toBe(V.hubPub);
    const input = ackSigInput({ clientEk: unhex(V.cpub), hubEk: unhex(V.hpub), nc, nh, hubFingerprint: unhex(V.fp) });
    expect(hex(await hub.sign(input))).toBe(V.sig);
  });

  it('session keys from the shared secret, and sealed messages', async () => {
    const k = await deriveSessionKeys(unhex(V.shared), nc, nh);
    expect(hex(k.c2h)).toBe(V.c2h);
    expect(hex(k.h2c)).toBe(V.h2c);
    const pt = encodeControl({ t: 'ping' });
    expect(hex(pt)).toBe('007b2274223a2270696e67227d'); // inner kind 0x00 + {"t":"ping"}
    const client = await LinkSession.create(k.c2h, k.h2c);
    expect(hex(await client.seal(pt, 1))).toBe(V.sealedC2h1);
    const hub = await LinkSession.create(k.h2c, k.c2h);
    expect(hex(await hub.seal(pt, 5))).toBe(V.sealedH2c5);
    // and each side opens what the other sealed
    expect(await hub.open(unhex(V.sealedC2h1))).toEqual(pt);
    expect(await client.open(unhex(V.sealedH2c5))).toEqual(pt);
  });
});

describe('handshake', () => {
  it('client and Hub derive working session keys and the client learns the Hub key', async () => {
    const hub = await hubIdentity();
    const c = await startClientHandshake([1, 1]);
    expect(c.hello[0]).toBe(Kind.HELLO);
    const h = await acceptHello(c.hello, hub, [1, 1]);
    expect(h.ack[0]).toBe(Kind.HELLO_ACK);
    const done = await c.finish(h.ack);
    if ('busy' in done) throw new Error('busy');
    expect(hex(done.hubKey)).toBe(hex(hub.publicKey));
    expect(hex(done.hubFingerprint)).toBe(hex(h.hubFingerprint));
    expect(hex(done.nc)).toBe(hex(h.nc));
    expect(hex(done.nh)).toBe(hex(h.nh));
    const m = encodeCore(Uint8Array.of(1, 2, 3));
    expect(await h.session.open(await done.session.seal(m))).toEqual(m);
    expect(decodeInner(m)).toEqual({ kind: 'core', bytes: Uint8Array.of(1, 2, 3) });
  });

  it('a pinned Hub key that does not match aborts with hub-identity-changed', async () => {
    const hub = await hubIdentity(7);
    const other = await hubIdentity(8);
    const c = await startClientHandshake([1, 1]);
    const h = await acceptHello(c.hello, hub, [1, 1]);
    await expect(c.finish(h.ack, other.publicKey)).rejects.toMatchObject({ code: 'hub-identity-changed' });
  });

  it('a tampered transcript fails the signature', async () => {
    const hub = await hubIdentity();
    const c = await startClientHandshake([1, 1]);
    const h = await acceptHello(c.hello, hub, [1, 1]);
    const ack = JSON.parse(new TextDecoder().decode(h.ack.slice(1)));
    ack.nh = ack.nh.slice(0, -2) + (ack.nh.endsWith('AA') ? 'BB' : 'AA');
    const bad = new Uint8Array([Kind.HELLO_ACK, ...new TextEncoder().encode(JSON.stringify(ack))]);
    await expect(c.finish(bad)).rejects.toMatchObject({ code: 'bad-signature' });
  });

  it('non-overlapping version ranges fail on the Hub with version-mismatch', async () => {
    const hub = await hubIdentity();
    const c = await startClientHandshake([2, 3]);
    await expect(acceptHello(c.hello, hub, [1, 1])).rejects.toMatchObject({ code: 'version-mismatch' });
  });

  it('a busy hello-ack carries no keys and reports retryMs', async () => {
    const c = await startClientHandshake([1, 1]);
    const done = await c.finish(busyAck(1, 4000));
    expect(done).toEqual({ busy: { retryMs: 4000 } });
  });

  it('rejects junk hello and hello-ack', async () => {
    const hub = await hubIdentity();
    await expect(acceptHello(Uint8Array.of(0xf0, 1, 2, 3), hub, [1, 1])).rejects.toBeInstanceOf(LinkError);
    const c = await startClientHandshake([1, 1]);
    await expect(c.finish(Uint8Array.of(0xf1, 0x7b))).rejects.toBeInstanceOf(LinkError);
  });
});

describe('session', () => {
  async function pair() {
    const hub = await hubIdentity();
    const c = await startClientHandshake([1, 1]);
    const h = await acceptHello(c.hello, hub, [1, 1]);
    const done = await c.finish(h.ack);
    if ('busy' in done) throw new Error('busy');
    return { client: done.session, hub: h.session };
  }

  it('rejects a replayed message, accepts gaps, and rejects tampering', async () => {
    const { client, hub } = await pair();
    const m = encodeControl({ t: 'ping' });
    const one = await client.seal(m);
    const two = await client.seal(m);
    const three = await client.seal(m);
    expect(await hub.open(one)).toEqual(m);
    expect(await hub.open(one)).toBeNull(); // replay
    expect(await hub.open(three)).toEqual(m); // a message that was aborted in between is a gap, not an error
    expect(await hub.open(two)).toBeNull(); // older than three now
    const t = await client.seal(m);
    t[t.length - 1]! ^= 1;
    expect(await hub.open(t)).toBeNull();
    const wrongKind = await client.seal(m);
    wrongKind[0] = 0xe1;
    expect(await hub.open(wrongKind)).toBeNull();
  });

  it('the two directions use different keys (a message cannot be reflected back)', async () => {
    const { client } = await pair();
    const m = encodeControl({ t: 'ping' });
    expect(await client.open(await client.seal(m))).toBeNull();
  });

  it('decodes inner control and ignores unknown control types by returning them to the caller', () => {
    expect(decodeInner(encodeControl({ t: 'pong' }))).toEqual({ kind: 'control', msg: { t: 'pong' } });
    expect(decodeInner(encodeControl({ t: 'future-thing', x: 1 } as never))).toMatchObject({ kind: 'control', msg: { t: 'future-thing' } });
    expect(decodeInner(Uint8Array.of(0x7f, 1))).toBeNull();
    expect(decodeInner(Uint8Array.of(0x00, 0x7b))).toBeNull(); // bad JSON
    expect(decodeInner(new Uint8Array(0))).toBeNull();
  });
});
