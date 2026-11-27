/** In-memory `HubStore` (tests, simulator, and the base for other stores). Data survives close() and open() on the same instance. */

import type { ClientRecord, DeviceId, HubSettings, PacketId, ServedSpaceRecord, SpaceId } from '../types';
import type { HubStore } from './types';

export const DAY_MS = 86_400_000;

interface Rec {
  bytes: Uint8Array;
  receivedAt: number;
  delivered: number;
}

/** A shard (UTC day) has expired once it ended before `now - retentionDays`. */
export const shardExpired = (receivedAt: number, now: number, retentionDays: number): boolean =>
  (Math.floor(receivedAt / DAY_MS) + 1) * DAY_MS <= now - retentionDays * DAY_MS;

export function createMemoryStore(): HubStore {
  const packets = new Map<SpaceId, Map<PacketId, Rec>>();
  const spaces = new Map<SpaceId, ServedSpaceRecord>();
  const clients = new Map<DeviceId, ClientRecord>();
  let settings: HubSettings | undefined;
  let hubKey: Uint8Array | undefined;

  const space = (s: SpaceId) => {
    let m = packets.get(s);
    if (!m) packets.set(s, (m = new Map()));
    return m;
  };

  return {
    async open() {},
    async close() {},

    async loadHubKey() {
      return hubKey?.slice();
    },
    async saveHubKey(seed) {
      hubKey = seed.slice();
    },
    async settings() {
      return settings && { ...settings };
    },
    async saveSettings(s) {
      settings = { ...s };
    },

    async spaces() {
      return [...spaces.values()].map((r) => structuredClone(r));
    },
    async putSpace(r) {
      spaces.set(r.space, structuredClone(r));
    },
    async deleteSpace(s) {
      spaces.delete(s);
    },

    async clients() {
      return [...clients.values()].map((r) => structuredClone(r));
    },
    async putClient(r) {
      clients.set(r.device, structuredClone(r));
    },
    async deleteClient(d) {
      clients.delete(d);
    },

    async addPacket(s, id, bytes, receivedAt) {
      const m = space(s);
      if (m.has(id)) return false;
      m.set(id, { bytes: bytes.slice(), receivedAt, delivered: 0 });
      return true;
    },
    async getPackets(s, ids) {
      const m = packets.get(s);
      const out: Array<{ id: PacketId; bytes: Uint8Array }> = [];
      for (const id of ids) {
        const r = m?.get(id);
        if (r) out.push({ id, bytes: r.bytes.slice() });
      }
      return out;
    },
    async *listIds(s) {
      for (const [id, r] of [...(packets.get(s) ?? [])]) yield { id, size: r.bytes.length, receivedAt: r.receivedAt, delivered: r.delivered };
    },
    async markDelivered(s, ids) {
      const m = packets.get(s);
      for (const id of ids) {
        const r = m?.get(id);
        if (r) r.delivered++;
      }
    },
    async deleteSpacePackets(s) {
      packets.delete(s);
    },

    async usage() {
      const perSpace: Record<SpaceId, number> = {};
      let total = 0;
      for (const [s, m] of packets) {
        let n = 0;
        for (const r of m.values()) n += r.bytes.length;
        if (m.size) perSpace[s] = n;
        total += n;
      }
      return { total, perSpace };
    },

    async enforce({ now, retentionDays, limitBytes }) {
      const dropped: Array<{ space: SpaceId; id: PacketId }> = [];
      let expired = 0;
      let evictedDelivered = 0;
      let evictedUndelivered = 0;
      let total = 0;
      for (const [s, m] of packets) {
        for (const [id, r] of [...m]) {
          if (shardExpired(r.receivedAt, now, retentionDays)) {
            m.delete(id);
            dropped.push({ space: s, id });
            expired++;
          } else {
            total += r.bytes.length;
          }
        }
        if (!m.size) packets.delete(s);
      }
      if (total > limitBytes) {
        const all: Array<{ s: SpaceId; id: PacketId; r: Rec; order: number }> = [];
        let order = 0;
        for (const [s, m] of packets) for (const [id, r] of m) all.push({ s, id, r, order: order++ });
        const byAge = (a: (typeof all)[number], b: (typeof all)[number]) => a.r.receivedAt - b.r.receivedAt || a.order - b.order;
        const delivered = all.filter((x) => x.r.delivered >= 1).sort(byAge);
        const undelivered = all.filter((x) => x.r.delivered < 1).sort(byAge);
        for (const x of delivered) {
          if (total <= limitBytes) break;
          packets.get(x.s)!.delete(x.id);
          dropped.push({ space: x.s, id: x.id });
          total -= x.r.bytes.length;
          evictedDelivered++;
        }
        for (const x of undelivered) {
          if (total <= limitBytes) break;
          packets.get(x.s)!.delete(x.id);
          dropped.push({ space: x.s, id: x.id });
          total -= x.r.bytes.length;
          evictedUndelivered++;
        }
        for (const [s, m] of packets) if (!m.size) packets.delete(s);
      }
      return { expired, evictedDelivered, evictedUndelivered, dropped };
    },
  };
}
