/**
 * Segment store (research R-10): per-Space, day-sharded, append-only files of packets exactly as received, with an in-memory index
 * rebuilt on open. Crash-safe: every record carries its length and a CRC, a torn last record is discarded on open, and files that
 * are rewritten (eviction) are replaced atomically. Retention deletes whole expired day shards.
 *
 *   packets/<space>/<YYYYMMDD>.seg   header "HSEG" u16 version u16 0; then records: u32 len | body | u32 crc32(body)
 *                                    body: u8 idLen | id | f64 receivedAt | payload
 *   packets/<space>/delivered.log    records: u8 idLen | id | u32 crc32(id)       (one per delivery acknowledgment)
 *   meta/{settings,spaces,clients}.json, meta/key.bin
 */

import type { ClientRecord, DeviceId, HubSettings, PacketId, ServedSpaceRecord, SpaceId } from '../types';
import type { FsPort } from './fsPort';
import { shardExpired } from './memoryStore';
import type { HubStore } from './types';

const MAGIC = [0x48, 0x53, 0x45, 0x47]; // "HSEG"
const VERSION = 1;
const HEADER = Uint8Array.from([...MAGIC, 0, VERSION, 0, 0]);
const DAY_MS = 86_400_000;
const enc = new TextEncoder();
const dec = new TextDecoder();

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const dayKey = (t: number): string => {
  const d = new Date(Math.floor(t / DAY_MS) * DAY_MS);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
};
const dayStart = (key: string): number => Date.UTC(+key.slice(0, 4), +key.slice(4, 6) - 1, +key.slice(6, 8));

export class SegmentFormatError extends Error {}

interface Entry {
  day: string;
  /** Offset of the record's length prefix in the segment file. */
  offset: number;
  idLen: number;
  size: number;
  receivedAt: number;
  delivered: number;
}

const u32 = (n: number) => Uint8Array.of((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
const readU32 = (b: Uint8Array, o: number) => ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
const f64 = (n: number) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, n);
  return b;
};
function concat(...p: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(p.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of p) {
    out.set(x, o);
    o += x.length;
  }
  return out;
}

function record(id: string, receivedAt: number, payload: Uint8Array): Uint8Array {
  const idb = enc.encode(id);
  if (idb.length > 255) throw new RangeError('packet id too long');
  const body = concat(Uint8Array.of(idb.length), idb, f64(receivedAt), payload);
  return concat(u32(body.length), body, u32(crc32(body)));
}

/** Parse records from a segment; returns them and the length of the valid prefix. */
function scanSegment(b: Uint8Array): { entries: Array<{ id: string; offset: number; idLen: number; size: number; receivedAt: number }>; valid: number } {
  if (b.length < HEADER.length) return { entries: [], valid: 0 };
  for (let i = 0; i < 4; i++) if (b[i] !== MAGIC[i]) throw new SegmentFormatError('not a Hub segment file');
  const version = (b[4]! << 8) | b[5]!;
  if (version !== VERSION) throw new SegmentFormatError(`unsupported segment version ${version}`);
  const entries: Array<{ id: string; offset: number; idLen: number; size: number; receivedAt: number }> = [];
  let o = HEADER.length;
  while (o + 4 <= b.length) {
    const len = readU32(b, o);
    if (len < 10 || o + 4 + len + 4 > b.length) break;
    const body = b.subarray(o + 4, o + 4 + len);
    if (readU32(b, o + 4 + len) !== crc32(body)) break;
    const idLen = body[0]!;
    if (1 + idLen + 8 > body.length) break;
    entries.push({
      id: dec.decode(body.subarray(1, 1 + idLen)),
      offset: o,
      idLen,
      size: body.length - (1 + idLen + 8),
      receivedAt: new DataView(body.buffer, body.byteOffset + 1 + idLen, 8).getFloat64(0),
    });
    o += 4 + len + 4;
  }
  return { entries, valid: o };
}

function toJson(v: unknown): Uint8Array {
  return enc.encode(
    JSON.stringify(v, (_k, x) => (x instanceof Uint8Array ? { $b: btoa(String.fromCharCode(...x)) } : x)),
  );
}
function fromJson<T>(b: Uint8Array): T {
  return JSON.parse(dec.decode(b), (_k, x) => (x && typeof x === 'object' && typeof (x as { $b?: unknown }).$b === 'string' ? Uint8Array.from(atob((x as { $b: string }).$b), (c) => c.charCodeAt(0)) : x)) as T;
}

export function createSegmentStore(fs: FsPort): HubStore {
  const index = new Map<SpaceId, Map<PacketId, Entry>>();
  const sizes = new Map<string, number>();
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  };
  const seg = (space: string, day: string) => `packets/${space}/${day}.seg`;
  const spaceIdx = (space: string) => {
    let m = index.get(space);
    if (!m) index.set(space, (m = new Map()));
    return m;
  };

  async function loadSpace(space: string): Promise<void> {
    const m = new Map<PacketId, Entry>();
    for (const f of (await fs.list(`packets/${space}`)).filter((n) => /^\d{8}\.seg$/.test(n)).sort()) {
      const path = `packets/${space}/${f}`;
      const raw = (await fs.read(path)) ?? new Uint8Array(0);
      const { entries, valid } = scanSegment(raw);
      if (raw.length === 0 || valid === 0) {
        if (raw.length) await fs.writeAtomic(path, HEADER); // only a torn header: start the file again
        sizes.set(path, HEADER.length);
        continue;
      }
      if (valid < raw.length) await fs.writeAtomic(path, raw.slice(0, valid)); // discard the torn tail, keep everything before it
      sizes.set(path, valid);
      for (const e of entries) if (!m.has(e.id)) m.set(e.id, { day: f.slice(0, 8), offset: e.offset, idLen: e.idLen, size: e.size, receivedAt: e.receivedAt, delivered: 0 });
    }
    const log = await fs.read(`packets/${space}/delivered.log`);
    if (log) {
      let o = 0;
      while (o < log.length) {
        const idLen = log[o]!;
        if (o + 1 + idLen + 4 > log.length) break;
        const idb = log.subarray(o + 1, o + 1 + idLen);
        if (readU32(log, o + 1 + idLen) !== crc32(idb)) break;
        const e = m.get(dec.decode(idb));
        if (e) e.delivered++;
        o += 1 + idLen + 4;
      }
    }
    if (m.size) index.set(space, m);
  }

  async function rewriteShard(space: string, day: string): Promise<void> {
    const path = seg(space, day);
    const keep = [...spaceIdx(space).entries()].filter(([, e]) => e.day === day).sort((a, b) => a[1].offset - b[1].offset);
    const old = (await fs.read(path)) ?? new Uint8Array(0);
    if (!keep.length) {
      await fs.remove(path);
      sizes.delete(path);
      return;
    }
    const parts: Uint8Array[] = [HEADER];
    let o = HEADER.length;
    for (const [, e] of keep) {
      const len = readU32(old, e.offset);
      const rec = old.slice(e.offset, e.offset + 4 + len + 4);
      e.offset = o;
      o += rec.length;
      parts.push(rec);
    }
    await fs.writeAtomic(path, concat(...parts));
    sizes.set(path, o);
  }

  async function compactDeliveredLog(space: string): Promise<void> {
    const m = index.get(space);
    const parts: Uint8Array[] = [];
    for (const [id, e] of m ?? []) {
      const idb = enc.encode(id);
      for (let i = 0; i < e.delivered; i++) parts.push(concat(Uint8Array.of(idb.length), idb, u32(crc32(idb))));
    }
    if (parts.length) await fs.writeAtomic(`packets/${space}/delivered.log`, concat(...parts));
    else await fs.remove(`packets/${space}/delivered.log`);
  }

  return {
    open: () =>
      serial(async () => {
        index.clear();
        sizes.clear();
        for (const space of await fs.listDirs('packets')) await loadSpace(space);
      }),
    close: () => serial(async () => undefined),

    loadHubKey: async () => fs.read('meta/key.bin'),
    saveHubKey: (seed) => serial(() => fs.writeAtomic('meta/key.bin', seed)),
    async settings() {
      const b = await fs.read('meta/settings.json');
      return b && fromJson<HubSettings>(b);
    },
    saveSettings: (s) => serial(() => fs.writeAtomic('meta/settings.json', toJson(s))),

    async spaces() {
      const b = await fs.read('meta/spaces.json');
      return b ? fromJson<ServedSpaceRecord[]>(b) : [];
    },
    putSpace: (r) =>
      serial(async () => {
        const b = await fs.read('meta/spaces.json');
        const all = (b ? fromJson<ServedSpaceRecord[]>(b) : []).filter((x) => x.space !== r.space);
        await fs.writeAtomic('meta/spaces.json', toJson([...all, r]));
      }),
    deleteSpace: (space) =>
      serial(async () => {
        const b = await fs.read('meta/spaces.json');
        await fs.writeAtomic('meta/spaces.json', toJson((b ? fromJson<ServedSpaceRecord[]>(b) : []).filter((x) => x.space !== space)));
      }),

    async clients() {
      const b = await fs.read('meta/clients.json');
      return b ? fromJson<ClientRecord[]>(b) : [];
    },
    putClient: (r) =>
      serial(async () => {
        const b = await fs.read('meta/clients.json');
        const all = (b ? fromJson<ClientRecord[]>(b) : []).filter((x) => x.device !== r.device);
        await fs.writeAtomic('meta/clients.json', toJson([...all, r]));
      }),
    deleteClient: (device: DeviceId) =>
      serial(async () => {
        const b = await fs.read('meta/clients.json');
        await fs.writeAtomic('meta/clients.json', toJson((b ? fromJson<ClientRecord[]>(b) : []).filter((x) => x.device !== device)));
      }),

    addPacket: (space, id, bytes, receivedAt) =>
      serial(async () => {
        const m = spaceIdx(space);
        if (m.has(id)) return false;
        const day = dayKey(receivedAt);
        const path = seg(space, day);
        const rec = record(id, receivedAt, bytes);
        let size = sizes.get(path);
        if (size === undefined) {
          await fs.append(path, HEADER);
          size = HEADER.length;
        }
        await fs.append(path, rec);
        m.set(id, { day, offset: size, idLen: enc.encode(id).length, size: bytes.length, receivedAt, delivered: 0 });
        sizes.set(path, size + rec.length);
        return true;
      }),

    async getPackets(space, ids) {
      const m = index.get(space);
      const out: Array<{ id: PacketId; bytes: Uint8Array }> = [];
      for (const id of ids) {
        const e = m?.get(id);
        if (!e) continue;
        const b = await fs.readRange(seg(space, e.day), e.offset + 4 + 1 + e.idLen + 8, e.size);
        if (b && b.length === e.size) out.push({ id, bytes: b });
      }
      return out;
    },

    async *listIds(space) {
      for (const [id, e] of [...(index.get(space) ?? [])]) yield { id, size: e.size, receivedAt: e.receivedAt, delivered: e.delivered };
    },

    markDelivered: (space, ids) =>
      serial(async () => {
        const m = index.get(space);
        const parts: Uint8Array[] = [];
        for (const id of ids) {
          const e = m?.get(id);
          if (!e) continue;
          e.delivered++;
          const idb = enc.encode(id);
          parts.push(concat(Uint8Array.of(idb.length), idb, u32(crc32(idb))));
        }
        if (parts.length) await fs.append(`packets/${space}/delivered.log`, concat(...parts));
      }),

    deleteSpacePackets: (space) =>
      serial(async () => {
        index.delete(space);
        for (const k of [...sizes.keys()]) if (k.startsWith(`packets/${space}/`)) sizes.delete(k);
        await fs.removeDir(`packets/${space}`);
      }),

    async usage() {
      const perSpace: Record<SpaceId, number> = {};
      let total = 0;
      for (const [space, m] of index) {
        let n = 0;
        for (const e of m.values()) n += e.size;
        if (m.size) perSpace[space] = n;
        total += n;
      }
      return { total, perSpace };
    },

    enforce: ({ now, retentionDays, limitBytes }) =>
      serial(async () => {
        const dropped: Array<{ space: SpaceId; id: PacketId }> = [];
        let expired = 0;
        let evictedDelivered = 0;
        let evictedUndelivered = 0;
        const dirty = new Set<string>();
        const touched = new Set<SpaceId>();
        // 1. whole expired day shards
        for (const [space, m] of index) {
          const days = new Set([...m.values()].map((e) => e.day));
          for (const day of days) {
            if (!shardExpired(dayStart(day), now, retentionDays)) continue;
            for (const [id, e] of [...m]) {
              if (e.day !== day) continue;
              m.delete(id);
              dropped.push({ space, id });
              expired++;
            }
            await fs.remove(seg(space, day));
            sizes.delete(seg(space, day));
            touched.add(space);
          }
        }
        // 2. storage pressure: delivered first, then undelivered, oldest first
        let total = 0;
        for (const m of index.values()) for (const e of m.values()) total += e.size;
        if (total > limitBytes) {
          const all: Array<{ space: SpaceId; id: PacketId; e: Entry; order: number }> = [];
          let order = 0;
          for (const [space, m] of index) for (const [id, e] of m) all.push({ space, id, e, order: order++ });
          const byAge = (a: (typeof all)[number], b: (typeof all)[number]) => a.e.receivedAt - b.e.receivedAt || a.order - b.order;
          const victims = [...all.filter((x) => x.e.delivered >= 1).sort(byAge), ...all.filter((x) => x.e.delivered < 1).sort(byAge)];
          for (const v of victims) {
            if (total <= limitBytes) break;
            index.get(v.space)!.delete(v.id);
            dropped.push({ space: v.space, id: v.id });
            total -= v.e.size;
            if (v.e.delivered >= 1) evictedDelivered++;
            else evictedUndelivered++;
            dirty.add(`${v.space}\n${v.e.day}`);
            touched.add(v.space);
          }
          for (const key of dirty) {
            const [space, day] = key.split('\n') as [string, string];
            await rewriteShard(space, day);
          }
        }
        for (const space of touched) {
          if (!index.get(space)?.size) index.delete(space);
          await compactDeliveredLog(space);
        }
        return { expired, evictedDelivered, evictedUndelivered, dropped };
      }),
  };
}
