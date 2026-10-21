import { HLC } from './clock/hlc';
import { History } from './history/history';
import type { Snapshot } from './history/snapshot';
import { Emitter } from './events';
import { Extensions } from './extension/registry';
import { QueryEngine } from './query/engine';
import { newDeviceId } from './packet/ids';
import { QuotaMonitor } from './storage/quota';
import { Applier, type LocalState } from './store/apply';
import { ObjectCache } from './store/cache';
import { stateHash } from './store/hash';
import { isVisible, toSyncable } from './store/objects';
import { SummaryCache } from './store/summaries';
import { LocalWriter } from './store/write';
import { TransportManager } from './sync/manager';
import type { SyncEnv } from './sync/session';
import type { Transport } from './sync/transport';
import {
  resolveConfig,
  type Config,
  type CoreEvent,
  type IngestResult,
  type JSONValue,
  type ObjectId,
  type Query,
  type QuerySpec,
  type SpaceId,
  type SyncCore,
  type SyncableObject,
  type UNSET,
} from './types';
import type { PacketValidator, PayloadCodec } from './extension/types';

class CoreImpl implements SyncCore {
  constructor(
    readonly deviceId: string,
    private readonly parts: {
      cfg: ReturnType<typeof resolveConfig>;
      ext: Extensions;
      cache: ObjectCache;
      queries: QueryEngine;
      applier: Applier;
      writer: LocalWriter;
      events: Emitter<CoreEvent>;
      manager: TransportManager;
      history: History;
      stopTimers: () => void;
    },
  ) {}

  // ---- extensions ----
  registerCodec(codec: PayloadCodec, opts?: { makeDefault?: boolean }): void {
    this.parts.ext.registerCodec(codec, opts);
  }
  registerValidator(validator: PacketValidator): void {
    this.parts.ext.registerValidator(validator);
  }
  revalidate(opts?: { space?: string }): Promise<{ applied: number; stillParked: number }> {
    return this.parts.applier.revalidate(opts);
  }

  // ---- objects ----
  create(space: SpaceId, type: string, fields: Record<string, JSONValue>, opts?: { schemaVersion?: number; id?: ObjectId }) {
    return this.parts.writer.create(space, type, fields, opts);
  }
  update(id: ObjectId, fields: Record<string, JSONValue | typeof UNSET>) {
    return this.parts.writer.update(id, fields);
  }
  remove(id: ObjectId) {
    return this.parts.writer.remove(id);
  }
  async get(id: ObjectId): Promise<SyncableObject | undefined> {
    const o = this.parts.cache.get(id);
    return o && isVisible(o, this.parts.cfg.resurrectingTypes) ? toSyncable(o) : undefined;
  }

  query(spec: QuerySpec): Query {
    return this.parts.queries.query(spec);
  }

  ingest(raw: Uint8Array, source: string): Promise<IngestResult> {
    return this.parts.applier.ingest(raw, source);
  }

  ingestBatch(raws: readonly Uint8Array[], source: string): Promise<IngestResult[]> {
    return this.parts.applier.ingestBatch(raws, source);
  }

  // ---- transports (FR-014) ----
  addTransport(t: Transport): void {
    this.parts.manager.add(t);
  }
  removeTransport(id: string): Promise<void> {
    return this.parts.manager.remove(id);
  }
  transports(): ReadonlyArray<{ id: string; state: string }> {
    return this.parts.manager.list();
  }

  // ---- history (FR-018, FR-019) ----
  undo(id: ObjectId): Promise<void> {
    return this.parts.history.undo(id);
  }
  history(id: ObjectId) {
    return this.parts.history.history(id);
  }
  compact(opts?: { space?: SpaceId; olderThanMs?: number }) {
    return this.parts.history.compact(opts);
  }
  exportSnapshot(space: SpaceId): Promise<Snapshot | undefined> {
    return this.parts.history.exportSnapshot(space);
  }
  installSnapshot(snapshot: Snapshot): Promise<void> {
    return this.parts.history.installSnapshot(snapshot);
  }

  stateHash(space: SpaceId): Promise<string> {
    return this.parts.applier.serial(() => stateHash(this.parts.cache, space));
  }

  on(cb: (e: CoreEvent) => void): () => void {
    return this.parts.events.on(cb);
  }

  async close(): Promise<void> {
    this.parts.stopTimers();
    await this.parts.manager.closeAll();
    await this.parts.applier.serial(async () => undefined);
    await this.parts.cfg.storage.close();
  }
}

/** Open a core on the given storage. State is loaded from storage; no transport is required. */
export async function createSyncCore(config: Config): Promise<SyncCore> {
  const cfg = resolveConfig(config);
  const events = new Emitter<CoreEvent>();
  const ext = new Extensions();
  for (const c of config.codecs ?? []) ext.registerCodec(c);
  for (const v of config.validators ?? []) ext.registerValidator(v);

  const quota = new QuotaMonitor(cfg.storage, (e) => events.emit(e), cfg.now);
  await quota.requestPersistence();

  let state = await cfg.storage.transaction(['meta'], 'readwrite', async (tx) => {
    const existing = await tx.get<LocalState>('meta', 'state');
    if (existing) {
      if (cfg.deviceId && cfg.deviceId !== existing.deviceId) {
        throw new Error(`storage belongs to device ${existing.deviceId}, not ${cfg.deviceId}`);
      }
      return existing;
    }
    const fresh: LocalState = {
      deviceId: cfg.deviceId ?? newDeviceId(),
      seqCounter: 0,
      lastClock: '',
      hlc: { wall: 0, counter: 0 },
    };
    await tx.put('meta', 'state', fresh);
    return fresh;
  });

  const hlc = new HLC(state.deviceId, cfg.now, cfg.maxDriftMs, state.hlc);
  const cache = new ObjectCache();
  await cache.load(cfg.storage);
  const summaries = new SummaryCache(cfg.storage);
  const queries = new QueryEngine(cache, cfg.resurrectingTypes);
  const applier = new Applier({
    storage: cfg.storage,
    ext,
    cfg,
    hlc,
    cache,
    summaries,
    queries,
    events,
    quota,
    getState: () => state,
    setState: (s) => void (state = s),
  });
  const writer = new LocalWriter({ applier, ext, cfg, hlc, cache, quota, getState: () => state });
  const knownSpaces = async (): Promise<string[]> => {
    const s = new Set<string>(cfg.spaces);
    await cfg.storage.transaction(['summary'], 'readonly', async (tx) => {
      for await (const { key } of tx.scan('summary')) s.add(key);
    });
    return [...s].sort();
  };
  const relayFor = (space: string) => (typeof cfg.relay === 'boolean' ? cfg.relay : (cfg.relay[space] ?? true));
  const env: SyncEnv = { storage: cfg.storage, summaries, applier, cfg, events, deviceId: state.deviceId, spaces: knownSpaces, relayFor };
  const manager = new TransportManager(env);
  manager.markKnown(await knownSpaces());
  applier.accepted.on((a) => manager.onAccepted(a));
  const history = new History({ storage: cfg.storage, cache, ext, cfg, applier, writer, deviceId: state.deviceId, spaces: knownSpaces });

  // Compaction: early when storage is under pressure, and in the background on a schedule.
  let compacting = false;
  const compactInBackground = () => {
    if (compacting) return;
    compacting = true;
    history
      .compact()
      .catch(() => undefined)
      .finally(() => (compacting = false));
  };
  events.on((e) => e.kind === 'storage:pressure' && compactInBackground());
  const timers: ReturnType<typeof setTimeout>[] = [];
  if (cfg.autoCompact) {
    const first = setTimeout(compactInBackground, 10_000);
    const every = setInterval(compactInBackground, 6 * 60 * 60 * 1000);
    (first as { unref?: () => void }).unref?.();
    (every as { unref?: () => void }).unref?.();
    timers.push(first, every);
  }
  const stopTimers = () => timers.forEach((t) => clearTimeout(t));
  return new CoreImpl(state.deviceId, { cfg, ext, cache, queries, applier, writer, events, manager, history, stopTimers });
}
