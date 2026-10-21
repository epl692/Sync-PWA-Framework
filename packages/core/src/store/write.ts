/** Local write path (specs/001-sync-core/data-model.md "Local write path"). */

import { maxClock, nextAfter, type HLC } from '../clock/hlc';
import type { Extensions } from '../extension/registry';
import { buildEnvelope, encodeEnvelope } from '../packet/envelope';
import { newObjectId } from '../packet/ids';
import { StorageQuotaError } from '../storage/types';
import type { QuotaMonitor } from '../storage/quota';
import {
  NoCodecError,
  ObjectNotFoundError,
  UNSET,
  type JSONValue,
  type ObjectId,
  type PacketBody,
  type ResolvedConfig,
  type SpaceId,
  type SyncableObject,
} from '../types';
import { Applier, type LocalState } from './apply';
import type { ObjectCache } from './cache';
import { isVisible, toSyncable } from './objects';

export class PacketRejectedError extends Error {
  readonly code = 'packet-rejected';
  constructor(reason: string) {
    super(`Packet rejected: ${reason}`);
    this.name = 'PacketRejectedError';
  }
}

export interface WriterDeps {
  applier: Applier;
  ext: Extensions;
  cfg: ResolvedConfig;
  hlc: HLC;
  cache: ObjectCache;
  quota: QuotaMonitor;
  getState(): LocalState;
}

type Change =
  | { op: 'create'; obj: ObjectId; space: SpaceId; type: string; schemaVersion: number; fields: Record<string, JSONValue> }
  | { op: 'update'; obj: ObjectId; fields: Record<string, JSONValue> }
  | { op: 'delete'; obj: ObjectId };

export class LocalWriter {
  constructor(private readonly d: WriterDeps) {}

  private requireCodec() {
    const codec = this.d.ext.defaultCodec();
    if (!codec) throw new NoCodecError();
    return codec;
  }

  async create(
    space: SpaceId,
    type: string,
    fields: Record<string, JSONValue>,
    opts: { schemaVersion?: number; id?: ObjectId } = {},
  ): Promise<SyncableObject> {
    this.requireCodec();
    const id = opts.id ?? newObjectId();
    await this.commit({ op: 'create', obj: id, space, type, schemaVersion: opts.schemaVersion ?? 1, fields });
    return toSyncable(this.d.cache.get(id)!);
  }

  async update(id: ObjectId, fields: Record<string, JSONValue | typeof UNSET>): Promise<SyncableObject> {
    this.requireCodec();
    const clean: Record<string, JSONValue> = {};
    for (const [k, v] of Object.entries(fields)) clean[k] = v === UNSET ? { $unset: true } : (v as JSONValue);
    await this.commit({ op: 'update', obj: id, fields: clean });
    return toSyncable(this.d.cache.get(id)!);
  }

  async remove(id: ObjectId): Promise<void> {
    this.requireCodec();
    await this.commit({ op: 'delete', obj: id });
  }

  /** Re-assert field values on a deleted object (undoing a delete for types that allow edit-resurrects). */
  async reassert(id: ObjectId, fields: Record<string, JSONValue>): Promise<void> {
    this.requireCodec();
    await this.commit({ op: 'update', obj: id, fields }, true);
  }

  private commit(change: Change, allowHidden = false): Promise<void> {
    const d = this.d;
    return d.applier.serial(async () => {
      const codec = this.requireCodec();
      const existing = d.cache.get(change.obj);
      if (change.op !== 'create' && (!existing || (!allowHidden && !isVisible(existing, d.cfg.resurrectingTypes)))) {
        throw new ObjectNotFoundError(change.obj);
      }
      const state = d.getState();
      const space = change.op === 'create' ? change.space : existing!.space;
      const type = change.op === 'create' ? change.type : existing!.type;
      const schemaVersion = change.op === 'create' ? change.schemaVersion : existing!.schemaVersion;
      const fields = change.op === 'delete' ? {} : change.fields;

      // One clock per packet: above our local HLC, above every stored clock of the fields we touch
      // (so a user can overwrite what they have seen, even a skewed value), and above our last packet.
      let clock = d.hlc.tick();
      if (state.lastClock) clock = maxClock(clock, nextAfter(state.lastClock, state.deviceId));
      if (existing) {
        for (const name of Object.keys(fields)) {
          const prev = existing.fields[name];
          if (prev) clock = maxClock(clock, nextAfter(prev.clock, state.deviceId));
        }
      }

      const body: PacketBody = { obj: change.obj, op: change.op, type, schemaVersion, fields };
      const seq = state.seqCounter + 1;
      const envBody = await codec.encode(body, { space, author: state.deviceId });
      const env = buildEnvelope({ author: state.deviceId, seq, space, clock, codec: codec.id, body: envBody, sig: null });

      const sendVerdict = await d.ext.validate('send', env, body, { now: d.cfg.now, existing });
      if (sendVerdict.verdict !== 'accept') throw new PacketRejectedError(sendVerdict.reason);

      const raw = encodeEnvelope(env);
      if (raw.byteLength > d.cfg.limits.maxEnvelopeBytes) {
        throw new PacketRejectedError(`envelope is ${raw.byteLength} bytes (limit ${d.cfg.limits.maxEnvelopeBytes})`);
      }
      const nextState: LocalState = { ...state, seqCounter: seq, lastClock: clock, hlc: d.hlc.state() };
      try {
        const result = await d.applier.applyDecoded({ env, raw, unsupportedVersion: false }, 'local', { body, nextState });
        if (result.status === 'rejected') throw new PacketRejectedError(result.reason);
      } catch (e) {
        if (e instanceof StorageQuotaError) await d.quota.reportExceeded();
        throw e;
      }
    });
  }
}
