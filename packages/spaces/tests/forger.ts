/** Builds packets a hostile or modified client could produce, using a real node's own device and keys. */
import { buildEnvelope, decodeEnvelope, encodeEnvelope, formatClock, newId, type DataPacketEnvelope, type PacketBody } from '@sync/core';
import type { SecureNode } from '@sync/testkit';
import { Keystore, SPACE_CODEC_ID } from '../src';
import { SpaceCodec, type KeyAccess } from '../src/codec/spaceCodec';
import { signBytes } from '../src/crypto/suite';
import { signingInput } from '../src/validators/spacesValidator';

export interface ForgeOpts {
  seq?: number;
  /** Wall-clock milliseconds for the packet clock (default: the node's fake clock). */
  wall?: number;
  sign?: boolean;
  /** Sign with another forger's device key instead. */
  signWith?: Forger;
  tamper?: (e: DataPacketEnvelope) => DataPacketEnvelope;
  /** Use this scope's key (default: the Space). */
  scope?: string;
}

export class Forger {
  private constructor(
    readonly node: SecureNode,
    readonly ks: Keystore,
    private readonly codec: SpaceCodec,
  ) {}

  static async of(node: SecureNode): Promise<Forger> {
    const ks = await Keystore.open(node.keyDb);
    const access: KeyAccess = {
      scopeFor: (space) => space,
      writeKey: async (scope) => {
        const held = await ks.epochs(scope);
        const top = held[held.length - 1];
        const key = top && (await ks.aesKey(scope, top.keyId));
        return top && key ? { epoch: top.epoch, keyId: top.keyId, key } : undefined;
      },
      readKey: (scope, keyId) => ks.aesKey(scope, keyId),
      used: async () => 1,
    };
    return new Forger(node, ks, new SpaceCodec(access));
  }

  get id(): string {
    return this.ks.requireDevice().deviceId;
  }

  /** The next sequence number this device has not used in the Space. */
  async nextSeq(space: string): Promise<number> {
    const held = await this.node.core.held(space);
    return (held[this.id] ?? []).reduce((m, [, hi]) => Math.max(m, hi), 0) + 1;
  }

  body(type: string, fields: unknown, obj: string = newId(), op: PacketBody['op'] = 'create'): PacketBody {
    return { obj, op, type, schemaVersion: 1, fields: fields as never };
  }

  async packet(space: string, body: PacketBody, o: ForgeOpts = {}): Promise<{ env: DataPacketEnvelope; raw: Uint8Array }> {
    const dev = this.ks.requireDevice();
    const seq = o.seq ?? (await this.nextSeq(space));
    const clock = formatClock(o.wall ?? this.node.clock.now() + 1000 + seq, 0, dev.deviceId);
    const bytes = await this.codec.encode(body, { space, author: dev.deviceId, envelope: { v: 1, id: `${dev.deviceId}:${seq}`, seq, clock, codec: SPACE_CODEC_ID } });
    let env = buildEnvelope({ author: dev.deviceId, seq, space, clock, codec: SPACE_CODEC_ID, body: bytes, sig: null });
    if (o.sign !== false) {
      const priv = (o.signWith ? o.signWith.ks.requireDevice() : dev).signPriv;
      env = { ...env, sig: await signBytes(priv, signingInput(encodeEnvelope(env))) };
    }
    if (o.tamper) env = o.tamper(env);
    const raw = encodeEnvelope(env);
    return { env: decodeEnvelope(raw).env, raw };
  }
}
