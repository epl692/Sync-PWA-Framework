/**
 * The single path every packet takes, local or remote (FR-005): dedup, decode, limits, validators,
 * merge, then one atomic commit of the object, the packet, the summary and (for local packets) the
 * outbox entry and device state.
 */

import { HLC } from '../clock/hlc';
import { Emitter } from '../events';
import type { Extensions } from '../extension/registry';
import type { Change, QueryEngine } from '../query/engine';
import { decodeEnvelope, EnvelopeError, type DecodedEnvelope } from '../packet/envelope';
import { QuotaMonitor } from '../storage/quota';
import { StorageQuotaError, type StorageAdapter } from '../storage/types';
import { addValue } from '../sync/intervals';
import type { CoreEvent, DataPacketEnvelope, IngestResult, PacketBody, ResolvedConfig, SyncableObject } from '../types';
import { ObjectCache } from './cache';
import { canonicalString } from '../packet/canonical';
import { mergeSnapshots, type Snapshot } from '../history/snapshot';
import { mergeIntervals } from '../sync/intervals';
import { joinObjects, mergeInto, toSyncable, type StoredObject } from './objects';
import { addOutbox, newOutboxEntry } from './outbox';
import { SummaryCache, type SummaryRecord } from './summaries';

const ctxOf = (env: DataPacketEnvelope) => ({
  space: env.space,
  author: env.author,
  envelope: { v: env.v, id: env.id, seq: env.seq, clock: env.clock, codec: env.codec },
});

/** Device-level state persisted under meta/state in the same transaction as each local packet. */
export interface LocalState {
  deviceId: string;
  seqCounter: number;
  lastClock: string;
  hlc: { wall: number; counter: number };
}

/** A packet record as stored in the `packets` store. */
export interface PacketRecord {
  id: string;
  space: string;
  author: string;
  seq: number;
  clock: string;
  raw: Uint8Array;
  /** 'rejected' packets stay in the log (the set of packets is the same everywhere) but are never applied or forwarded. */
  status: 'applied' | 'parked' | 'rejected';
  reason?: string;
  obj?: string;
  /** Body type, kept so callers can find packets by type without decoding (A-8). */
  type?: string;
  op?: PacketBody['op'];
  fields?: string[];
  receivedAt: number;
  source: string;
}

/** A packet that was stored (applied or parked), announced so the sync layer can forward it. */
export interface Accepted {
  space: string;
  id: string;
  raw: Uint8Array;
  /** 'local' or `${transportId}:${peerId}` (any string for packets ingested directly). */
  source: string;
  status: 'applied' | 'parked';
}

export interface LocalCommit {
  body: PacketBody;
  nextState: LocalState;
}

export interface ApplierDeps {
  storage: StorageAdapter;
  ext: Extensions;
  cfg: ResolvedConfig;
  hlc: HLC;
  cache: ObjectCache;
  summaries: SummaryCache;
  queries: QueryEngine;
  events: Emitter<CoreEvent>;
  quota: QuotaMonitor;
  getState(): LocalState;
  setState(s: LocalState): void;
}

export class Applier {
  private tail: Promise<unknown> = Promise.resolve();
  readonly accepted = new Emitter<Accepted>();
  /** Fires after every packet that is applied and committed, including parked packets applied later (A-8). */
  readonly applied = new Emitter<{ env: DataPacketEnvelope; body: PacketBody; source: string; object?: SyncableObject }>();

  constructor(private readonly d: ApplierDeps) {}

  /** Serialise anything that reads-then-writes packet state. */
  serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }

  /** Remote packets: raw envelope bytes from a transport. */
  async ingest(raw: Uint8Array, source: string): Promise<IngestResult> {
    let decoded: DecodedEnvelope;
    try {
      decoded = decodeEnvelope(raw, this.d.cfg.limits.maxEnvelopeBytes);
    } catch (e) {
      const reason = e instanceof EnvelopeError ? `${e.code}: ${e.message}` : String(e);
      this.d.events.emit({ kind: 'packet:rejected', id: '', reason });
      return { status: 'rejected', reason };
    }
    return this.serial(() => this.applyDecoded(decoded, source));
  }

  /** A batch of remote packets applied in order; live queries re-evaluate once at the end. */
  async ingestBatch(raws: readonly Uint8Array[], source: string): Promise<IngestResult[]> {
    return this.serial(() =>
      this.d.queries.batch(async () => {
        const decodedAll: Array<DecodedEnvelope | IngestResult> = [];
        for (const raw of raws) {
          try {
            decodedAll.push(decodeEnvelope(raw, this.d.cfg.limits.maxEnvelopeBytes));
          } catch (e) {
            const reason = e instanceof EnvelopeError ? `${e.code}: ${e.message}` : String(e);
            this.d.events.emit({ kind: 'packet:rejected', id: '', reason });
            decodedAll.push({ status: 'rejected', reason });
          }
        }
        await this.d.ext.prepare(decodedAll.filter((x): x is DecodedEnvelope => 'env' in x).map((x) => ({ envelope: x.env, raw: x.raw })));
        const out: IngestResult[] = [];
        for (const item of decodedAll) out.push('env' in item ? await this.applyDecoded(item, source) : item);
        return out;
      }),
    );
  }

  /**
   * Install a peer's snapshot: join its objects into ours, remember its coverage as held, and keep the
   * union so we can pass the snapshot on. Idempotent and order independent.
   */
  installSnapshot(snap: Snapshot): Promise<void> {
    return this.serial(async () => {
      const d = this.d;
      const space = snap.space;
      await d.summaries.ensure(space);
      const { summary, changed } = await d.storage.transaction(['objects', 'snapshots', 'summary'], 'readwrite', async (tx) => {
        await tx.put('snapshots', space, mergeSnapshots(await tx.get<Snapshot>('snapshots', space), snap));
        const rec = (await tx.get<SummaryRecord>('summary', space)) ?? { space, held: {} };
        for (const [author, iv] of Object.entries(snap.covers)) rec.held[author] = mergeIntervals(rec.held[author] ?? [], iv);
        await tx.put('summary', space, rec);
        const changed: StoredObject[] = [];
        for (const obj of snap.objects) {
          const live = await tx.get<StoredObject>('objects', obj.id);
          const joined = joinObjects(live, obj);
          if (!live || canonicalString(joined) !== canonicalString(live)) {
            await tx.put('objects', joined.id, joined);
            changed.push(joined);
          }
        }
        return { summary: rec, changed };
      });
      d.summaries.commit(summary);
      for (const o of changed) d.cache.set(o);
      d.queries.notify(changed.map((o) => ({ id: o.id, types: [o.type] })));
    });
  }

  /** Retry every parked packet (a codec or key may have arrived, or a validator changed its mind). Oldest clock first. */
  revalidate(opts: { space?: string } = {}): Promise<{ applied: number; stillParked: number }> {
    return this.serial(() =>
      this.d.queries.batch(async () => {
        const parked = await this.d.storage.transaction(['packets'], 'readonly', async (tx) => {
          const out: PacketRecord[] = [];
          for await (const { value } of tx.scan<PacketRecord>('packets')) {
            if (value.status === 'parked' && (!opts.space || value.space === opts.space)) out.push(value);
          }
          return out;
        });
        parked.sort((a, b) => (a.clock < b.clock ? -1 : a.clock > b.clock ? 1 : a.id < b.id ? -1 : 1));
        let applied = 0;
        let stillParked = 0;
        for (const rec of parked) {
          let decoded: DecodedEnvelope;
          try {
            decoded = decodeEnvelope(rec.raw);
          } catch {
            stillParked++;
            continue;
          }
          const r = await this.applyDecoded(decoded, rec.source, undefined, true);
          if (r.status === 'applied') applied++;
          else stillParked++;
        }
        return { applied, stillParked };
      }),
    );
  }

  /**
   * A-2: clear the derived state of a Space and replay every retained packet (applied, parked or rejected)
   * through the codec and validators in clock order. Returns how many packets changed status.
   */
  rebuildSpace(space: string): Promise<{ reapplied: number; rejected: number }> {
    return this.serial(() =>
      this.d.queries.batch(async () => {
        const d = this.d;
        const recs = await d.storage.transaction(['packets', 'snapshots'], 'readonly', async (tx) => {
          const rows: PacketRecord[] = [];
          for await (const { value } of tx.scan<PacketRecord>('packets', { index: 'bySpace', range: { gte: space, lt: `${space}\u0000` } })) rows.push(value);
          return { rows, snap: await tx.get<Snapshot>('snapshots', space) };
        });
        recs.rows.sort((a, b) => (a.clock < b.clock ? -1 : a.clock > b.clock ? 1 : a.id < b.id ? -1 : 1));
        const objs = new Map<string, StoredObject>((recs.snap?.objects ?? []).map((o) => [o.id, structuredClone(o)]));
        let reapplied = 0;
        let rejected = 0;
        const changedRecs: PacketRecord[] = [];
        for (const rec of recs.rows) {
          let status: PacketRecord['status'] = 'applied';
          let reason: string | undefined;
          let body: PacketBody | undefined;
          let decoded: DecodedEnvelope | undefined;
          try {
            decoded = decodeEnvelope(rec.raw);
          } catch {
            status = 'parked';
            reason = 'undecodable-codec';
          }
          if (decoded) {
            const env = decoded.env;
            if (decoded.unsupportedVersion) {
              status = 'parked';
              reason = 'unknown-version';
            } else {
              const codec = d.ext.codec(env.codec);
              if (!codec) {
                status = 'parked';
                reason = 'undecodable-codec';
              } else {
                const dr = await codec.decode(env.body, ctxOf(env));
                if (dr.ok) body = dr.body;
                else if (dr.reason === 'malformed') {
                  status = 'rejected';
                  reason = 'malformed body';
                } else {
                  status = 'parked';
                  reason = 'undecodable-codec';
                }
              }
            }
            if (status === 'applied' || status === 'parked') {
              const verdict = await d.ext.validate('apply', env, body, { now: d.cfg.now, existing: body ? objs.get(body.obj) : undefined, raw: rec.raw, source: rec.source });
              if (verdict.verdict === 'reject') {
                status = 'rejected';
                reason = verdict.reason;
              } else if (verdict.verdict === 'defer') {
                status = 'parked';
                reason = reason ?? 'validator-deferred';
              }
            }
            if (status === 'applied' && body) objs.set(body.obj, mergeInto(objs.get(body.obj), body, env).obj);
            else if (status === 'applied') status = 'parked';
          }
          if (status !== rec.status) {
            if (status === 'rejected') rejected++;
            if (status === 'applied') reapplied++;
            changedRecs.push({ ...rec, status, reason, ...(status === 'applied' && body ? { obj: body.obj, type: body.type, op: body.op, fields: Object.keys(body.fields) } : {}) });
          }
        }
        const cached = [...d.cache.all()].filter((o) => o.space === space);
        const removed = cached.filter((o) => !objs.has(o.id));
        const upserts = [...objs.values()].filter((o) => {
          const cur = d.cache.get(o.id);
          return !cur || canonicalString(cur) !== canonicalString(o);
        });
        if (!removed.length && !upserts.length && !changedRecs.length) return { reapplied, rejected };
        await d.storage.transaction(['objects', 'packets'], 'readwrite', async (tx) => {
          for (const o of removed) await tx.delete('objects', o.id);
          for (const o of upserts) await tx.put('objects', o.id, o);
          for (const r of changedRecs) await tx.put('packets', r.id, r);
        });
        const changes: Change[] = [];
        for (const o of removed) {
          d.cache.delete(o.id);
          changes.push({ id: o.id, types: [o.type] });
        }
        for (const o of upserts) {
          const before = d.cache.get(o.id);
          d.cache.set(o);
          changes.push({ id: o.id, types: before && before.type !== o.type ? [o.type, before.type] : [o.type] });
        }
        d.queries.notify(changes);
        this.parked = undefined;
        return { reapplied, rejected };
      }),
    );
  }

  /** Must be called from inside `serial`. `local` carries the already-decoded body and the state to persist. */
  async applyDecoded(decoded: DecodedEnvelope, source: string, local?: LocalCommit, reapply = false): Promise<IngestResult> {
    const { env } = decoded;
    const d = this.d;
    await d.summaries.ensure(env.space);
    if (!reapply && d.summaries.has(env.space, env.author, env.seq)) return { status: 'duplicate', id: env.id };

    let body: PacketBody | undefined = local?.body;
    let parkReason: string | undefined;
    if (!local) {
      if (decoded.unsupportedVersion) parkReason = 'unknown-version';
      else {
        const codec = d.ext.codec(env.codec);
        if (!codec) parkReason = 'undecodable-codec';
        else {
          const dr = await codec.decode(env.body, ctxOf(env));
          if (dr.ok) body = dr.body;
          else if (dr.reason === 'malformed') return this.reject(env, 'malformed body');
          else parkReason = 'undecodable-codec';
        }
      }
    }

    if (body) {
      const n = Object.keys(body.fields).length;
      if (n > d.cfg.limits.maxFieldsPerPacket) {
        return this.reject(env, `too many fields (${n} > ${d.cfg.limits.maxFieldsPerPacket})`);
      }
      if (body.op === 'delete' && n > 0) return this.reject(env, 'delete packets must not carry fields');
    }

    const existing = body ? d.cache.get(body.obj) : undefined;
    const verdict = await d.ext.validate('apply', env, body, { now: d.cfg.now, existing, raw: decoded.raw, source });
    if (verdict.verdict === 'reject') return this.reject(env, verdict.reason);
    if (verdict.verdict === 'defer') parkReason ??= 'validator-deferred';

    if (!local && !reapply) {
      const prevMax = d.summaries.maxSeq(env.space, env.author);
      if (prevMax > 0 && env.seq - prevMax > d.cfg.limits.seqGapWarn) {
        d.events.emit({ kind: 'sync:progress', peer: source, space: env.space, received: 0, warning: 'seq-gap' });
      }
    }

    if (reapply && (parkReason || !body)) return { status: 'parked', id: env.id, reason: parkReason ?? 'undecodable-codec' };
    if (!local && (parkReason || !body)) {
      // A-7: bound what one author can park. Excess packets are neither stored nor counted as held,
      // so the summary stays honest and they are requested again later.
      const counts = await this.parkedCounts();
      if ((counts.get(`${env.space}\u0000${env.author}`) ?? 0) >= d.cfg.limits.maxParkedPerAuthor) return this.reject(env, 'parked-limit');
    }
    try {
      return parkReason || !body
        ? await this.commitParked(decoded, source, parkReason ?? 'undecodable-codec')
        : await this.commitApplied(env, decoded.raw, body, source, local, reapply);
    } catch (e) {
      if (e instanceof StorageQuotaError) {
        await d.quota.reportExceeded();
        if (local) throw e;
        return { status: 'rejected', id: env.id, reason: 'storage-quota' };
      }
      throw e;
    }
  }

  private parked: Map<string, number> | undefined;

  private async parkedCounts(): Promise<Map<string, number>> {
    if (this.parked) return this.parked;
    const counts = new Map<string, number>();
    await this.d.storage.transaction(['packets'], 'readonly', async (tx) => {
      for await (const { value } of tx.scan<PacketRecord>('packets')) {
        if (value.status === 'parked') {
          const k = `${value.space}\u0000${value.author}`;
          counts.set(k, (counts.get(k) ?? 0) + 1);
        }
      }
    });
    return (this.parked ??= counts);
  }

  private bumpParked(env: DataPacketEnvelope, by: number): void {
    if (!this.parked) return;
    const k = `${env.space}\u0000${env.author}`;
    this.parked.set(k, Math.max(0, (this.parked.get(k) ?? 0) + by));
  }

  private reject(env: DataPacketEnvelope, reason: string): IngestResult {
    this.d.events.emit({ kind: 'packet:rejected', id: env.id, reason });
    return { status: 'rejected', id: env.id, reason };
  }

  private heldWith(env: DataPacketEnvelope): SummaryRecord {
    const held = structuredClone(this.d.summaries.snapshot(env.space));
    held[env.author] = addValue(held[env.author] ?? [], env.seq);
    return { space: env.space, held };
  }

  private async commitParked(decoded: DecodedEnvelope, source: string, reason: string): Promise<IngestResult> {
    const { env, raw } = decoded;
    const d = this.d;
    const rec: PacketRecord = {
      id: env.id,
      space: env.space,
      author: env.author,
      seq: env.seq,
      clock: env.clock,
      raw,
      status: 'parked',
      reason,
      receivedAt: d.cfg.now(),
      source,
    };
    const summary = this.heldWith(env);
    await d.storage.transaction(['packets', 'summary'], 'readwrite', async (tx) => {
      await tx.put('packets', env.id, rec);
      await tx.put('summary', env.space, summary);
    });
    d.summaries.commit(summary);
    this.bumpParked(env, 1);
    if (env.clock) d.hlc.receive(env.clock);
    d.events.emit({ kind: 'packet:parked', id: env.id, reason });
    this.accepted.emit({ space: env.space, id: env.id, raw, source, status: 'parked' });
    return { status: 'parked', id: env.id, reason };
  }

  private async commitApplied(
    env: DataPacketEnvelope,
    raw: Uint8Array,
    body: PacketBody,
    source: string,
    local?: LocalCommit,
    reapply = false,
  ): Promise<IngestResult> {
    const d = this.d;
    const summary = this.heldWith(env);
    const rec: PacketRecord = {
      id: env.id,
      space: env.space,
      author: env.author,
      seq: env.seq,
      clock: env.clock,
      raw,
      status: 'applied',
      obj: body.obj,
      type: body.type,
      op: body.op,
      fields: Object.keys(body.fields),
      receivedAt: d.cfg.now(),
      source,
    };
    const stores = local
      ? (['objects', 'packets', 'summary', 'outbox', 'meta'] as const)
      : (['objects', 'packets', 'summary'] as const);
    const { obj, before, changed } = await d.storage.transaction(stores, 'readwrite', async (tx) => {
      const before = await tx.get<StoredObject>('objects', body.obj);
      const merged = mergeInto(before, body, env);
      await tx.put('objects', merged.obj.id, merged.obj);
      await tx.put('packets', env.id, rec);
      await tx.put('summary', env.space, summary);
      if (local) {
        await addOutbox(tx, newOutboxEntry(env.id, env.space, d.cfg.now()));
        await tx.put('meta', 'state', local.nextState);
      }
      return { obj: merged.obj, before, changed: merged.changed };
    });

    // Committed: now (and only now) update in-memory mirrors.
    d.summaries.commit(summary);
    if (reapply) this.bumpParked(env, -1);
    d.cache.set(obj);
    if (local) d.setState(local.nextState);
    else if (!reapply) d.hlc.receive(env.clock);
    if (changed) {
      const types = before && before.type !== obj.type ? [obj.type, before.type] : [obj.type];
      d.queries.notify([{ id: obj.id, types } satisfies Change]);
    }
    void d.quota.checkSoon();
    if (!reapply) this.accepted.emit({ space: env.space, id: env.id, raw, source: local ? 'local' : source, status: 'applied' });
    this.applied.emit({ env, body, source: local ? 'local' : source, object: toSyncable(obj) });
    return { status: 'applied', id: env.id };
  }
}
