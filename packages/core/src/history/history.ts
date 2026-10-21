/** History: the packet log, undo by compensating packets, and compaction into snapshots (FR-018, FR-019). */

import { decodeEnvelope } from '../packet/envelope';
import type { Extensions } from '../extension/registry';
import type { PacketRecord } from '../store/apply';
import { Applier } from '../store/apply';
import type { ObjectCache } from '../store/cache';
import { isVisible, mergeInto, type StoredObject } from '../store/objects';
import type { LocalWriter } from '../store/write';
import { addValue } from '../sync/intervals';
import type { StorageAdapter } from '../storage/types';
import {
  NotUndoableError,
  UNSET,
  type DataPacketEnvelope,
  type DeviceId,
  type JSONValue,
  type ObjectId,
  type PacketBody,
  type ResolvedConfig,
  type SpaceId,
} from '../types';
import { mergeSnapshots, type Snapshot } from './snapshot';
import type { Held } from '../store/summaries';

export interface HistoryEntry {
  packetId: string;
  clock: string;
  op: string;
  fields: string[];
}

export interface HistoryDeps {
  storage: StorageAdapter;
  cache: ObjectCache;
  ext: Extensions;
  cfg: ResolvedConfig;
  applier: Applier;
  writer: LocalWriter;
  deviceId: DeviceId;
  spaces(): Promise<string[]>;
}

const DELETE_CHUNK = 500;

export class History {
  constructor(private readonly d: HistoryDeps) {}

  /** Applied packets that touched one object, oldest first. */
  private async records(space: SpaceId, id: ObjectId): Promise<PacketRecord[]> {
    const out = await this.d.storage.transaction(['packets'], 'readonly', async (tx) => {
      const rows: PacketRecord[] = [];
      for await (const { value } of tx.scan<PacketRecord>('packets', { index: 'bySpace', range: { gte: space, lt: `${space}\u0000` } })) {
        if (value.status === 'applied' && value.obj === id) rows.push(value);
      }
      return rows;
    });
    return out.sort((a, b) => (a.clock < b.clock ? -1 : a.clock > b.clock ? 1 : 0));
  }

  async history(id: ObjectId): Promise<HistoryEntry[]> {
    const obj = this.d.cache.get(id);
    if (!obj) return [];
    return (await this.records(obj.space, id)).map((r) => ({ packetId: r.id, clock: r.clock, op: r.op ?? 'update', fields: r.fields ?? [] }));
  }

  private async bodyOf(rec: PacketRecord): Promise<PacketBody | undefined> {
    try {
      const { env } = decodeEnvelope(rec.raw);
      const codec = this.d.ext.codec(env.codec);
      if (!codec) return undefined;
      const r = await codec.decode(env.body, { space: env.space, author: env.author, envelope: { v: env.v, id: env.id, seq: env.seq, clock: env.clock, codec: env.codec } });
      return r.ok ? r.body : undefined;
    } catch {
      return undefined;
    }
  }

  /** Reverse this device's most recent change to the object with a new compensating packet. */
  async undo(id: ObjectId): Promise<void> {
    const d = this.d;
    const obj = d.cache.get(id);
    if (!obj) throw new NotUndoableError('unknown object');
    const recs = await this.records(obj.space, id);
    const mine = recs.filter((r) => r.author === d.deviceId);
    const last = mine[mine.length - 1];
    if (!last) throw new NotUndoableError('this device has no change to reverse');
    if (d.cfg.now() - last.receivedAt > d.cfg.retentionWindowMs) throw new NotUndoableError('the change is outside the retention window');
    const hidden = !isVisible(obj, d.cfg.resurrectingTypes);

    if (last.op === 'create') {
      if (hidden) throw new NotUndoableError('the object is already deleted');
      await d.writer.remove(id);
      return;
    }
    if (last.op === 'delete') {
      if (!d.cfg.resurrectingTypes.has(obj.type)) throw new NotUndoableError(`type "${obj.type}" does not allow undoing a delete`);
      const fields: Record<string, JSONValue> = {};
      for (const [name, f] of Object.entries(obj.fields)) fields[name] = f.value;
      if (!Object.keys(fields).length) throw new NotUndoableError('there is nothing to restore');
      await d.writer.reassert(id, fields);
      return;
    }

    // An update: put each touched field back to the value it had just before that packet.
    const snapshot = await this.d.storage.transaction(['snapshots'], 'readonly', (tx) => tx.get<Snapshot>('snapshots', obj.space));
    const snapObj = snapshot?.objects.find((o) => o.id === id);
    const restore: Record<string, JSONValue | typeof UNSET> = {};
    for (const name of last.fields ?? []) {
      let best: { clock: string; rec?: PacketRecord; value?: JSONValue } | undefined;
      for (const r of recs) {
        if (r.clock < last.clock && r.fields?.includes(name) && (!best || r.clock > best.clock)) best = { clock: r.clock, rec: r };
      }
      const fromSnap = snapObj?.fields[name];
      if (fromSnap && fromSnap.clock < last.clock && (!best || fromSnap.clock > best.clock)) best = { clock: fromSnap.clock, value: fromSnap.value };
      if (!best) {
        restore[name] = UNSET; // the field did not exist before
        continue;
      }
      let value = best.value;
      if (best.rec) {
        const body = await this.bodyOf(best.rec);
        if (!body) throw new NotUndoableError('earlier history cannot be read');
        value = body.fields[name];
      }
      restore[name] = value === undefined || (typeof value === 'object' && value !== null && !Array.isArray(value) && (value as Record<string, JSONValue>).$unset === true) ? UNSET : (value as JSONValue);
    }
    if (hidden) throw new NotUndoableError('the object is deleted');
    await d.writer.update(id, restore);
  }

  /**
   * A-8: decoded applied packets of a Space, oldest clock first. With `typePrefix`, only packets whose body type
   * starts with it are decoded and returned (packets recorded before `type` was kept are decoded to find out).
   */
  async scanApplied(space: SpaceId, opts: { typePrefix?: string } = {}): Promise<Array<{ env: DataPacketEnvelope; body: PacketBody }>> {
    const rows = await this.d.storage.transaction(['packets'], 'readonly', async (tx) => {
      const out: PacketRecord[] = [];
      for await (const { value } of tx.scan<PacketRecord>('packets', { index: 'bySpace', range: { gte: space, lt: `${space}\u0000` } })) {
        if (value.status !== 'applied') continue;
        if (opts.typePrefix !== undefined && value.type !== undefined && !value.type.startsWith(opts.typePrefix)) continue;
        out.push(value);
      }
      return out;
    });
    rows.sort((a, b) => (a.clock < b.clock ? -1 : a.clock > b.clock ? 1 : a.id < b.id ? -1 : 1));
    const out: Array<{ env: DataPacketEnvelope; body: PacketBody }> = [];
    for (const rec of rows) {
      const body = await this.bodyOf(rec);
      if (!body || (opts.typePrefix !== undefined && !body.type.startsWith(opts.typePrefix))) continue;
      out.push({ env: decodeEnvelope(rec.raw).env, body });
    }
    return out;
  }

  async exportSnapshot(space: SpaceId): Promise<Snapshot | undefined> {
    return this.d.storage.transaction(['snapshots'], 'readonly', (tx) => tx.get<Snapshot>('snapshots', space));
  }

  installSnapshot(snapshot: Snapshot): Promise<void> {
    return this.d.applier.installSnapshot(snapshot);
  }

  /**
   * Fold packets older than the retention window into the Space's snapshot, then delete them.
   * The snapshot is written first, so a crash in between loses nothing (packets are merely redundant).
   */
  async compact(opts: { space?: SpaceId; olderThanMs?: number } = {}): Promise<{ packetsRemoved: number; bytesFreed?: number }> {
    const spaces = opts.space ? [opts.space] : await this.d.spaces();
    let packetsRemoved = 0;
    let bytesFreed = 0;
    for (const space of spaces) {
      const r = await this.d.applier.serial(() => this.compactSpace(space, opts.olderThanMs ?? this.d.cfg.retentionWindowMs));
      packetsRemoved += r.removed;
      bytesFreed += r.bytes;
    }
    return { packetsRemoved, bytesFreed };
  }

  private async compactSpace(space: SpaceId, olderThanMs: number): Promise<{ removed: number; bytes: number }> {
    const d = this.d;
    const cutoff = d.cfg.now() - olderThanMs;
    const eligible = await d.storage.transaction(['packets'], 'readonly', async (tx) => {
      const rows: PacketRecord[] = [];
      for await (const { value } of tx.scan<PacketRecord>('packets', { index: 'bySpace', range: { gte: space, lt: `${space}\u0000` } })) {
        if (value.status === 'applied' && value.receivedAt <= cutoff) rows.push(value);
      }
      return rows;
    });
    if (!eligible.length) return { removed: 0, bytes: 0 };

    const objects = new Map<string, StoredObject>();
    const covers: Held = {};
    const folded: PacketRecord[] = [];
    for (const rec of eligible.sort((a, b) => (a.clock < b.clock ? -1 : a.clock > b.clock ? 1 : 0))) {
      const body = await this.bodyOf(rec);
      if (!body) continue; // cannot read it now (e.g. a codec is missing): leave it in the log
      if (d.ext.isPinned(body.type, body.obj)) continue; // A-6: pinned objects are never folded or deleted
      objects.set(body.obj, mergeInto(objects.get(body.obj), body, { clock: rec.clock, space }).obj);
      covers[rec.author] = addValue(covers[rec.author] ?? [], rec.seq);
      folded.push(rec);
    }
    if (!folded.length) return { removed: 0, bytes: 0 };

    const fresh: Snapshot = { space, covers, objects: [...objects.values()], createdAt: d.cfg.now() };
    await d.storage.transaction(['snapshots'], 'readwrite', async (tx) => {
      await tx.put('snapshots', space, mergeSnapshots(await tx.get<Snapshot>('snapshots', space), fresh));
    });
    let bytes = 0;
    for (let i = 0; i < folded.length; i += DELETE_CHUNK) {
      const chunk = folded.slice(i, i + DELETE_CHUNK);
      await d.storage.transaction(['packets'], 'readwrite', async (tx) => {
        for (const rec of chunk) await tx.delete('packets', rec.id);
      });
      for (const rec of chunk) bytes += rec.raw.byteLength;
    }
    return { removed: folded.length, bytes };
  }
}
