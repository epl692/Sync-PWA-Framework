/**
 * One sync session per (transport, peer): hello, summary exchange, bounded packet batches, live
 * forwarding, acks. Implements specs/001-sync-core/contracts/sync-protocol.md.
 */

import type { Emitter } from '../events';
import { b64urlDecode, b64urlEncode } from '../packet/canonical';
import type { Snapshot } from '../history/snapshot';
import type { Applier, PacketRecord } from '../store/apply';
import { isStoredObject } from '../store/objects';
import { confirmOutbox } from '../store/outbox';
import type { Held, SummaryCache } from '../store/summaries';
import type { StorageAdapter } from '../storage/types';
import type { CoreEvent, ResolvedConfig } from '../types';
import { addRange, addValue, containsValue, countValues, diffIntervals, type Interval } from './intervals';
import { ANY_SPACE, decodeMessage, encodeMessage, PROTOCOL, splitPacketId, type Msg } from './messages';
import type { PeerInfo, Transport } from './transport';

export interface SyncEnv {
  storage: StorageAdapter;
  summaries: SummaryCache;
  applier: Applier;
  cfg: ResolvedConfig;
  events: Emitter<CoreEvent>;
  deviceId: string;
  spaces(): Promise<string[]>;
  relayFor(space: string): boolean;
}

const yieldNow = () => new Promise<void>((r) => setTimeout(r, 0));

export class PeerSession {
  readonly key: string;
  private inbox: Promise<void> = Promise.resolve();
  private dead = false;
  private peerSpaces: string[] | undefined;
  private shared = new Set<string>();
  private summarised = new Set<string>();
  private peerHeld = new Map<string, Held>();
  private expected = new Map<string, number>();
  private received = new Map<string, number>();
  private incomingSnapshots = new Map<string, { of: number; covers: Held; parts: Map<number, unknown[]> }>();

  constructor(
    private readonly env: SyncEnv,
    private readonly transport: Transport,
    readonly peer: PeerInfo,
  ) {
    this.key = `${transport.id}:${peer.id}`;
  }

  start(): void {
    void this.enqueue(() => this.sendHello());
  }

  close(): void {
    this.dead = true;
  }

  /** Tell the peer our Space list changed. */
  announce(): void {
    void this.enqueue(async () => {
      await this.sendHello();
      await this.syncSharedSpaces();
    });
  }

  onMessage(bytes: Uint8Array): void {
    void this.enqueue(() => this.handle(bytes));
  }

  /** Live forward of a newly accepted packet. */
  offer(space: string, id: string, raw: Uint8Array): void {
    void this.enqueue(async () => {
      // Until the peer's summary arrives, the catch-up push (which reads the log) will include this packet.
      if (!this.shared.has(space) || !this.peerHeld.has(space) || this.peerHas(space, id)) return;
      this.markPeerHas(space, id);
      await this.send({ t: 'packets', space, items: [b64urlEncode(raw)] });
    });
  }

  private enqueue(fn: () => Promise<void>): Promise<void> {
    this.inbox = this.inbox.then(() => (this.dead ? undefined : fn())).catch((e) => this.fail(e));
    return this.inbox;
  }

  private fail(e: unknown): void {
    this.env.events.emit({ kind: 'packet:rejected', id: '', reason: `session ${this.key}: ${(e as Error)?.message ?? e}` });
  }

  private async send(m: Msg): Promise<void> {
    if (this.dead) return;
    try {
      await this.transport.send(this.peer.id, encodeMessage(m));
    } catch {
      // the peer went away; the manager closes this session on peerDisconnected
    }
  }

  private async sendHello(): Promise<void> {
    await this.send({
      t: 'hello',
      protocol: { ...PROTOCOL },
      device: this.env.deviceId,
      spaces: await this.env.spaces(),
      relay: true,
    });
  }

  private peerHas(space: string, id: string): boolean {
    const p = splitPacketId(id);
    return !!p && containsValue(this.peerHeld.get(space)?.[p.author] ?? [], p.seq);
  }

  private markPeerHas(space: string, id: string): void {
    const p = splitPacketId(id);
    if (!p) return;
    const held = this.peerHeld.get(space) ?? {};
    held[p.author] = addValue(held[p.author] ?? [], p.seq);
    this.peerHeld.set(space, held);
  }

  private async handle(bytes: Uint8Array): Promise<void> {
    const d = decodeMessage(bytes, this.env.cfg.limits.maxMessageBytes);
    if (!d.ok) {
      this.env.events.emit({ kind: 'packet:rejected', id: '', reason: `${this.key}: ${d.reason}` });
      return;
    }
    if ('unknown' in d) return; // forward compatibility: ignore unknown message types
    const m = d.msg;
    switch (m.t) {
      case 'hello':
        return this.onHello(m);
      case 'summary':
        return this.onSummary(m);
      case 'want':
        return this.shared.has(m.space) ? this.sendRanges(m.space, this.relayable(m.space, m.ranges)) : undefined;
      case 'packets':
        return this.onPackets(m);
      case 'ack':
        return this.onAck(m);
      case 'ping':
        return this.send({ t: 'pong' });
      case 'error':
        if (m.fatal) this.dead = true;
        return;
      case 'snapshot':
        return this.onSnapshot(m);
      default:
        return; // pong
    }
  }

  private async onHello(m: Extract<Msg, { t: 'hello' }>): Promise<void> {
    const lo = Math.max(PROTOCOL.min, m.protocol.min);
    const hi = Math.min(PROTOCOL.max, m.protocol.max);
    if (lo > hi) {
      await this.send({ t: 'error', code: 'protocol-mismatch', message: 'no common protocol version', fatal: true });
      this.dead = true;
      return;
    }
    this.peerSpaces = m.spaces;
    await this.syncSharedSpaces();
  }

  private async syncSharedSpaces(): Promise<void> {
    if (!this.peerSpaces) return;
    const mine = await this.env.spaces();
    const any = this.peerSpaces.includes(ANY_SPACE);
    this.shared = new Set(mine.filter((s) => any || this.peerSpaces!.includes(s)));
    for (const space of this.shared) {
      if (this.summarised.has(space)) continue;
      this.summarised.add(space);
      await this.env.summaries.ensure(space);
      await this.send({ t: 'summary', space, held: this.env.summaries.snapshot(space) });
    }
  }

  private async onSummary(m: Extract<Msg, { t: 'summary' }>): Promise<void> {
    if (!this.shared.has(m.space)) return;
    this.peerHeld.set(m.space, structuredClone(m.held));
    const mine = this.env.summaries.snapshot(m.space);
    let missing = 0;
    for (const [author, iv] of Object.entries(m.held)) missing += countValues(diffIntervals(iv, mine[author] ?? []));
    this.expected.set(m.space, missing);
    await this.sendRanges(m.space, this.missingForPeer(m.space));
  }

  /** With relay off for a Space, a device sends only the packets it authored itself. */
  private relayable(space: string, ranges: Held): Held {
    if (this.env.relayFor(space)) return ranges;
    const own = ranges[this.env.deviceId];
    return own ? { [this.env.deviceId]: own } : {};
  }

  private missingForPeer(space: string): Held {
    const mine = this.env.summaries.snapshot(space);
    const theirs = this.peerHeld.get(space) ?? {};
    const out: Held = {};
    for (const [author, iv] of Object.entries(mine)) {
      const d = diffIntervals(iv, theirs[author] ?? []);
      if (d.length) out[author] = d;
    }
    return this.relayable(space, out);
  }

  /** True when part of what the peer lacks was compacted away, so only our snapshot can supply it. */
  private async snapshotFor(space: string, ranges: Held): Promise<Snapshot | undefined> {
    if (!this.env.relayFor(space)) return undefined;
    const snap = await this.env.storage.transaction(['snapshots'], 'readonly', (tx) => tx.get<Snapshot>('snapshots', space));
    if (!snap) return undefined;
    for (const [author, iv] of Object.entries(ranges)) {
      const covered = snap.covers[author] ?? [];
      if (iv.some((r) => diffIntervals([r], diffIntervals([r], covered)).length > 0)) return snap;
    }
    return undefined;
  }

  private async sendSnapshot(space: string, snap: Snapshot): Promise<void> {
    const perPart = 100;
    const of = Math.max(1, Math.ceil(snap.objects.length / perPart));
    for (let part = 0; part < of; part++) {
      await this.send({ t: 'snapshot', space, covers: snap.covers, objects: snap.objects.slice(part * perPart, (part + 1) * perPart), part, of });
      await yieldNow();
    }
    const held = this.peerHeld.get(space) ?? {};
    for (const [author, iv] of Object.entries(snap.covers)) held[author] = iv.reduce((acc, [lo, hi]) => addRangeTo(acc, lo, hi), held[author] ?? []);
    this.peerHeld.set(space, held);
  }

  private async onSnapshot(m: Extract<Msg, { t: 'snapshot' }>): Promise<void> {
    if (!this.shared.has(m.space)) return;
    let entry = this.incomingSnapshots.get(m.space);
    if (!entry || entry.of !== m.of) {
      entry = { of: m.of, covers: m.covers, parts: new Map() };
      this.incomingSnapshots.set(m.space, entry);
    }
    entry.parts.set(m.part, m.objects);
    if (entry.parts.size < entry.of) return;
    this.incomingSnapshots.delete(m.space);
    const objects = [...entry.parts.entries()].sort((a, b) => a[0] - b[0]).flatMap(([, objs]) => objs);
    if (!objects.every(isStoredObject) || objects.some((o) => o.space !== m.space)) {
      this.env.events.emit({ kind: 'packet:rejected', id: '', reason: `${this.key}: malformed snapshot` });
      return;
    }
    await this.env.applier.installSnapshot({ space: m.space, covers: entry.covers, objects, createdAt: this.env.cfg.now() });
    this.env.events.emit({ kind: 'sync:progress', peer: this.key, space: m.space, received: objects.length, total: objects.length });
  }

  /** Send the requested packet ranges in bounded batches, yielding between batches. */
  private async sendRanges(space: string, ranges: Held): Promise<void> {
    const { packets: maxPackets, bytes: maxBytes } = this.env.cfg.batch;
    const snap = await this.snapshotFor(space, ranges);
    if (snap) await this.sendSnapshot(space, snap);
    let items: string[] = [];
    let ids: string[] = [];
    let size = 0;
    const flush = async () => {
      if (!items.length) return;
      const batchItems = items;
      const batchIds = ids;
      items = [];
      ids = [];
      size = 0;
      await this.send({ t: 'packets', space, items: batchItems });
      for (const id of batchIds) this.markPeerHas(space, id);
      await yieldNow();
    };
    for (const [author, iv] of Object.entries(ranges)) {
      for (const [lo, hi] of iv) {
        for (let from = lo; from <= hi; from += maxPackets) {
          const to = Math.min(hi, from + maxPackets - 1);
          const recs = await this.env.storage.transaction(['packets'], 'readonly', async (tx) => {
            const out: PacketRecord[] = [];
            for (let seq = from; seq <= to; seq++) {
              const r = await tx.get<PacketRecord>('packets', `${author}:${seq}`);
              if (r) out.push(r);
            }
            return out;
          });
          for (const r of recs) {
            if (this.dead) return;
            const b64 = b64urlEncode(r.raw);
            if (items.length && (items.length >= maxPackets || size + b64.length > maxBytes)) await flush();
            items.push(b64);
            ids.push(r.id);
            size += b64.length;
          }
        }
      }
    }
    await flush();
  }

  private async onPackets(m: Extract<Msg, { t: 'packets'}>): Promise<void> {
    if (!this.shared.has(m.space)) return;
    const raws: Uint8Array[] = [];
    for (const item of m.items) {
      try {
        raws.push(b64urlDecode(item));
      } catch {
        this.env.events.emit({ kind: 'packet:rejected', id: '', reason: `${this.key}: bad base64url` });
      }
    }
    const results = await this.env.applier.ingestBatch(raws, this.key);
    const held: string[] = [];
    for (const r of results) {
      if (r.status === 'applied' || r.status === 'duplicate' || r.status === 'parked') {
        held.push(r.id);
        this.markPeerHas(m.space, r.id);
      }
    }
    const total = (this.received.get(m.space) ?? 0) + held.length;
    this.received.set(m.space, total);
    this.env.events.emit({ kind: 'sync:progress', peer: this.key, space: m.space, received: total, total: this.expected.get(m.space) });
    if (held.length) await this.send({ t: 'ack', space: m.space, ids: held });
  }

  private async onAck(m: Extract<Msg, { t: 'ack' }>): Promise<void> {
    for (const id of m.ids) this.markPeerHas(m.space, id);
    await confirmOutbox(this.env.storage, m.ids, this.key, this.env.cfg.confirmThreshold);
  }
}

const addRangeTo = (iv: Interval[], lo: number, hi: number): Interval[] => addRange(iv, lo, hi);

export type { Interval };
