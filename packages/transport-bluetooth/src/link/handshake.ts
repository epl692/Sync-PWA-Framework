/**
 * link/1 secure handshake (contracts/bluetooth-link.md#secure-handshake): ephemeral X25519, Hub-signed transcript (Ed25519),
 * HKDF-SHA-256 session keys. Pure Web Crypto.
 */

import { b64uDecode, b64uEncode, bs, concat, equalBytes, utf8, utf8d } from './bytes';
import { LinkSession } from './session';

export const LINK_LABEL = 'sync-link/1';
export const Kind = { HELLO: 0xf0, HELLO_ACK: 0xf1, ENCRYPTED: 0xe0 } as const;
export type VersionRange = [number, number];

export type LinkErrorCode = 'malformed' | 'version-mismatch' | 'bad-signature' | 'hub-identity-changed';
export class LinkError extends Error {
  constructor(
    readonly code: LinkErrorCode,
    message?: string,
  ) {
    super(message ?? code);
  }
}

export interface HubSigner {
  publicKey: Uint8Array;
  sign(msg: Uint8Array): Promise<Uint8Array>;
}

const subtle = () => globalThis.crypto.subtle;

export async function fingerprintBytes(hubPublic: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle().digest('SHA-256', bs(hubPublic)));
}

export function ackSigInput(a: { clientEk: Uint8Array; hubEk: Uint8Array; nc: Uint8Array; nh: Uint8Array; hubFingerprint: Uint8Array }): Uint8Array {
  return concat(utf8.encode(LINK_LABEL), a.clientEk, a.hubEk, a.nc, a.nh, a.hubFingerprint);
}

/** `HKDF-SHA-256(shared, salt = nc || nh, info = "sync-link/1 keys", 64)`: first half client-to-Hub, second Hub-to-client. */
export async function deriveSessionKeys(shared: Uint8Array, nc: Uint8Array, nh: Uint8Array): Promise<{ c2h: Uint8Array; h2c: Uint8Array }> {
  const base = await subtle().importKey('raw', bs(shared), 'HKDF', false, ['deriveBits']);
  const okm = new Uint8Array(
    await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: bs(concat(nc, nh)), info: bs(utf8.encode(`${LINK_LABEL} keys`)) }, base, 512),
  );
  return { c2h: okm.slice(0, 32), h2c: okm.slice(32) };
}

async function x25519Pair(): Promise<{ priv: CryptoKey; pub: Uint8Array }> {
  const kp = (await subtle().generateKey({ name: 'X25519' }, false, ['deriveBits'])) as CryptoKeyPair;
  return { priv: kp.privateKey, pub: new Uint8Array(await subtle().exportKey('raw', kp.publicKey)) };
}

async function ecdh(priv: CryptoKey, peerPub: Uint8Array): Promise<Uint8Array> {
  const peer = await subtle().importKey('raw', bs(peerPub), { name: 'X25519' }, false, []);
  const bits = new Uint8Array(await subtle().deriveBits({ name: 'X25519', public: peer }, priv, 256));
  if (bits.every((b) => b === 0)) throw new LinkError('malformed', 'degenerate shared secret');
  return bits;
}

const random = (n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n));
const kindMsg = (kind: number, obj: unknown) => concat(Uint8Array.of(kind), utf8.encode(JSON.stringify(obj)));

function parseJson(msg: Uint8Array, kind: number): Record<string, unknown> {
  if (msg[0] !== kind) throw new LinkError('malformed', 'unexpected message kind');
  try {
    const o = JSON.parse(utf8d.decode(msg.slice(1))) as unknown;
    if (o && typeof o === 'object') return o as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  throw new LinkError('malformed', 'unreadable handshake message');
}

const isRange = (v: unknown): v is VersionRange =>
  Array.isArray(v) && v.length === 2 && v.every((n) => Number.isInteger(n) && n >= 0) && (v as number[])[0]! <= (v as number[])[1]!;

export interface ClientHandshakeResult {
  session: LinkSession;
  hubKey: Uint8Array;
  hubFingerprint: Uint8Array;
  nc: Uint8Array;
  nh: Uint8Array;
  version: number;
}

export interface ClientHandshake {
  /** Plaintext hello (kind 0xF0) to send on `TX`. */
  hello: Uint8Array;
  /** Verify the Hub's ack. With `expectedHubKey` (a pinned Hub) a different key throws `hub-identity-changed`. */
  finish(ack: Uint8Array, expectedHubKey?: Uint8Array): Promise<ClientHandshakeResult | { busy: { retryMs: number } }>;
}

export async function startClientHandshake(range: VersionRange): Promise<ClientHandshake> {
  const kp = await x25519Pair();
  const nc = random(16);
  const hello = kindMsg(Kind.HELLO, { v: range, ek: b64uEncode(kp.pub), nc: b64uEncode(nc) });
  return {
    hello,
    async finish(ack, expectedHubKey) {
      const o = parseJson(ack, Kind.HELLO_ACK);
      const busy = o.busy as { retryMs?: unknown } | undefined;
      if (busy) {
        const retryMs = typeof busy.retryMs === 'number' && busy.retryMs >= 0 ? Math.min(busy.retryMs, 10 * 60_000) : 5000;
        return { busy: { retryMs } };
      }
      const version = o.v;
      if (typeof version !== 'number' || version < range[0] || version > range[1]) throw new LinkError('version-mismatch');
      const hubEk = b64uDecode(o.ek);
      const nh = b64uDecode(o.nh);
      const hubKey = b64uDecode(o.hubKey);
      const sig = b64uDecode(o.sig);
      if (!hubEk || hubEk.length !== 32 || !nh || nh.length !== 16 || !hubKey || hubKey.length !== 32 || !sig || sig.length !== 64) {
        throw new LinkError('malformed', 'bad hello-ack fields');
      }
      if (expectedHubKey && !equalBytes(expectedHubKey, hubKey)) throw new LinkError('hub-identity-changed');
      const hubFingerprint = await fingerprintBytes(hubKey);
      let ok = false;
      try {
        const key = await subtle().importKey('raw', bs(hubKey), { name: 'Ed25519' }, false, ['verify']);
        ok = await subtle().verify({ name: 'Ed25519' }, key, bs(sig), bs(ackSigInput({ clientEk: kp.pub, hubEk, nc, nh, hubFingerprint })));
      } catch {
        ok = false;
      }
      if (!ok) throw new LinkError('bad-signature');
      const keys = await deriveSessionKeys(await ecdh(kp.priv, hubEk), nc, nh);
      return { session: await LinkSession.create(keys.c2h, keys.h2c), hubKey, hubFingerprint, nc, nh, version };
    },
  };
}

export interface HubAccept {
  /** hello-ack (kind 0xF1) to send on `RX`. */
  ack: Uint8Array;
  session: LinkSession;
  nc: Uint8Array;
  nh: Uint8Array;
  hubFingerprint: Uint8Array;
  version: number;
}

/** Hub side: answer a client's hello. Throws `version-mismatch` or `malformed`. */
export async function acceptHello(hello: Uint8Array, hub: HubSigner, range: VersionRange): Promise<HubAccept> {
  const o = parseJson(hello, Kind.HELLO);
  if (!isRange(o.v)) throw new LinkError('malformed', 'bad version range');
  const lo = Math.max(o.v[0], range[0]);
  const hi = Math.min(o.v[1], range[1]);
  if (lo > hi) throw new LinkError('version-mismatch');
  const clientEk = b64uDecode(o.ek);
  const nc = b64uDecode(o.nc);
  if (!clientEk || clientEk.length !== 32 || !nc || nc.length !== 16) throw new LinkError('malformed', 'bad hello fields');
  const kp = await x25519Pair();
  const nh = random(16);
  const hubFingerprint = await fingerprintBytes(hub.publicKey);
  const sig = await hub.sign(ackSigInput({ clientEk, hubEk: kp.pub, nc, nh, hubFingerprint }));
  const keys = await deriveSessionKeys(await ecdh(kp.priv, clientEk), nc, nh);
  const ack = kindMsg(Kind.HELLO_ACK, { v: hi, ek: b64uEncode(kp.pub), nh: b64uEncode(nh), hubKey: b64uEncode(hub.publicKey), sig: b64uEncode(sig) });
  return { ack, session: await LinkSession.create(keys.h2c, keys.c2h), nc, nh, hubFingerprint, version: hi };
}

/** A hello-ack that says the Hub is full: no keys, the client backs off for about `retryMs`. */
export function busyAck(version: number, retryMs: number): Uint8Array {
  return kindMsg(Kind.HELLO_ACK, { v: version, busy: { retryMs } });
}
