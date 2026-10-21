/** Test helpers: real devices, a shared Space key, and genuinely signed + encrypted packets. */
import { b64urlEncode, base32, buildEnvelope, decodeEnvelope, encodeEnvelope, formatClock, newId, type DataPacketEnvelope, type PacketBody } from '@sync/core';
import { Authority } from '../src/authority/authority';
import { SYS, type ControlEvent, type ControlFields, type Role } from '../src/authority/types';
import { SPACE_CODEC_ID, SpaceCodec, type KeyAccess } from '../src/codec/spaceCodec';
import { hex, randomBytes } from '../src/crypto/bytes';
import { keyIdOf, spaceIdFor } from '../src/crypto/ids';
import { generateAesKey, generateAgreeKeyPair, generateSignKeyPair, signBytes } from '../src/crypto/suite';
import { deviceIdFromSignPub } from '../src/crypto/ids';
import { signingInput } from '../src/validators/spacesValidator';

export const T0 = 1_700_000_000_000;

export interface TestDevice {
  id: string;
  user: string;
  signPub: Uint8Array;
  agreePub: Uint8Array;
  signPriv: CryptoKey;
  agreePriv: CryptoKey;
  seq: number;
  name: string;
}

export async function makeDevice(name: string, user?: string): Promise<TestDevice> {
  const s = await generateSignKeyPair();
  const a = await generateAgreeKeyPair();
  const id = await deviceIdFromSignPub(s.publicRaw);
  return { id, user: user ?? id, signPub: s.publicRaw, agreePub: a.publicRaw, signPriv: s.privateKey, agreePriv: a.privateKey, seq: 0, name };
}

/** One shared key per scope, held by every test device (the validator tests do not need key distribution). */
export class World {
  readonly keys = new Map<string, { epoch: number; keyId: string; key: CryptoKey }>();
  readonly codec: SpaceCodec;
  space = '';
  nonce = randomBytes(16);
  private clockCounter = 0;

  constructor() {
    const access: KeyAccess = {
      scopeFor: (space, body) => (body.type.startsWith('$sys.') ? space : this.shareOf.get(body.obj) ?? space),
      writeKey: async (scope) => this.keys.get(scope),
      readKey: async (scope, keyId) => {
        const k = this.keys.get(scope);
        return k && k.keyId === keyId ? k.key : undefined;
      },
      used: async () => 1,
    };
    this.codec = new SpaceCodec(access);
  }

  readonly shareOf = new Map<string, string>();

  async addKey(scope: string, epoch = 0): Promise<string> {
    const raw = randomBytes(32);
    const keyId = hex(await keyIdOf(raw));
    const { importAesKey } = await import('../src/crypto/suite');
    this.keys.set(scope, { epoch, keyId, key: await importAesKey(raw) });
    void generateAesKey;
    return keyId;
  }

  async init(owner: TestDevice): Promise<void> {
    this.space = await spaceIdFor(owner.signPub, this.nonce);
    await this.addKey(this.space);
  }

  clock(dev: TestDevice, t: number): string {
    return formatClock(T0 + t, this.clockCounter++ % 1000, dev.id);
  }

  /** A packet authored by `dev`: encrypted with the scope key and signed (unless told otherwise). */
  async packet(
    dev: TestDevice,
    body: PacketBody,
    t: number,
    opts: { sign?: boolean; seq?: number; scopeSpace?: string; tamper?: (e: DataPacketEnvelope) => DataPacketEnvelope; signWith?: TestDevice } = {},
  ): Promise<{ env: DataPacketEnvelope; raw: Uint8Array }> {
    const seq = opts.seq ?? ++dev.seq;
    const clock = this.clock(dev, t);
    const space = opts.scopeSpace ?? this.space;
    const bodyBytes = await this.codec.encode(body, { space, author: dev.id, envelope: { v: 1, id: `${dev.id}:${seq}`, seq, clock, codec: SPACE_CODEC_ID } });
    let env = buildEnvelope({ author: dev.id, seq, space, clock, codec: SPACE_CODEC_ID, body: bodyBytes, sig: null });
    if (opts.sign !== false) {
      const signer = opts.signWith ?? dev;
      env = { ...env, sig: await signBytes(signer.signPriv, signingInput(encodeEnvelope(env))) };
    }
    if (opts.tamper) env = opts.tamper(env);
    const raw = encodeEnvelope(env);
    return { env: decodeEnvelope(raw).env, raw };
  }

  body(type: string, fields: unknown, obj = newId()): PacketBody {
    return { obj, op: 'create', type, schemaVersion: 1, fields: fields as never };
  }

  /** A control packet plus the ControlEvent the fold would see. */
  async control<T extends keyof ControlFields>(dev: TestDevice, type: T, fields: ControlFields[T], t: number, opts: Parameters<World['packet']>[3] = {}) {
    const p = await this.packet(dev, this.body(type, fields), t, opts);
    const event: ControlEvent = { id: p.env.id, type, clock: p.env.clock, author: dev.id, seq: p.env.seq, fields: fields as never };
    return { ...p, event };
  }
}

export const pub = (d: TestDevice) => ({ signPub: b64urlEncode(d.signPub), agreePub: b64urlEncode(d.agreePub) });

/** A Space with Owner A, Editor B, Viewer C (one device each), already folded into an Authority. */
export async function basicWorld() {
  const world = new World();
  const A = await makeDevice('A');
  const B = await makeDevice('B');
  const C = await makeDevice('C');
  await world.init(A);
  const auth = new Authority(world.space);
  const add = (e: { event: ControlEvent }) => auth.add(e.event);
  add(await world.control(A, SYS.genesis, { owner: { user: A.id, device: A.id, ...pub(A) }, nonce: b64urlEncode(world.nonce) }, 1));
  const binding = { kind: 'test', proof: '' };
  add(await world.control(A, SYS.device, { user: B.id, device: B.id, ...pub(B), binding }, 2));
  add(await world.control(A, SYS.member, { action: 'add', user: B.id, role: 'editor' as Role }, 3));
  add(await world.control(A, SYS.device, { user: C.id, device: C.id, ...pub(C), binding }, 4));
  add(await world.control(A, SYS.member, { action: 'add', user: C.id, role: 'viewer' as Role }, 5));
  return { world, A, B, C, auth, binding };
}

export { base32 };
