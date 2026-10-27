/** Fault injection for blob lane traffic: drop, duplicate, delay or reorder, and corrupt bytes in transit. Deterministic given a seed. */

import type { MemoryTransport } from '../memoryTransport';
import { seededRandom } from '../helpers';

const LANE_MAGIC = 0xb1;

/** Lane message type names, by the type byte after the magic (contracts/blob-protocol.md). */
export const LANE_TYPES = { hello: 1, offer: 2, get: 3, manifest: 4, chunk: 5, miss: 6, stored: 7, reject: 8, cancel: 9 } as const;
export type LaneTypeName = keyof typeof LANE_TYPES;

export const isLane = (bytes: Uint8Array): boolean => bytes.length > 1 && bytes[0] === LANE_MAGIC;
export const laneType = (bytes: Uint8Array): LaneTypeName | undefined =>
  isLane(bytes) ? (Object.entries(LANE_TYPES).find(([, v]) => v === bytes[1])?.[0] as LaneTypeName | undefined) : undefined;

/** A copy of `bytes` with one bit flipped. `byteOffset` counts from the start of the message (the magic is byte 0). */
export function flipBit(bytes: Uint8Array, byteOffset: number, bit = 0): Uint8Array {
  const out = bytes.slice();
  out[byteOffset]! ^= 1 << bit;
  return out;
}

/** Byte offsets of the payload in chunk (after magic, type, id32, index u32) and manifest (after magic, type, id32) messages. */
export const CHUNK_PAYLOAD_OFFSET = 2 + 32 + 4;
export const MANIFEST_PAYLOAD_OFFSET = 2 + 32;

export interface LaneFaultStats {
  seen: number;
  dropped: number;
  duplicated: number;
  delayed: number;
  corrupted: number;
}

interface Rule {
  match: (bytes: Uint8Array) => boolean;
  mutate: (bytes: Uint8Array) => Uint8Array;
  remaining: number;
}

/** Wrap a memory transport's `send` so lane messages (only) suffer the configured faults. Packets are never touched. */
export class LaneFaults {
  dropRate = 0;
  dupRate = 0;
  /** Fixed delay plus uniform jitter, in ms; jitter reorders messages. */
  delayMs = 0;
  jitterMs = 0;
  /** Which lane messages drop, duplication and delay apply to (default all). Corruption rules have their own matcher. */
  affect: (bytes: Uint8Array) => boolean = () => true;
  readonly stats: LaneFaultStats = { seen: 0, dropped: 0, duplicated: 0, delayed: 0, corrupted: 0 };
  /** Every lane message that was handed to a transport, as sent (before faults). */
  readonly sent: Array<{ from: string; to: string; bytes: Uint8Array }> = [];
  private rnd: () => number;
  private rules: Rule[] = [];

  constructor(seed = 1) {
    this.rnd = seededRandom(seed);
  }

  /** Corrupt the next `times` lane messages that match, by passing them through `mutate`. */
  corruptNext(match: (bytes: Uint8Array) => boolean, mutate: (bytes: Uint8Array) => Uint8Array, times = 1): void {
    this.rules.push({ match, mutate, remaining: times });
  }

  /** Flip one bit of the next `times` messages of a type, at `byteOffset` (default: the first payload byte). */
  tamper(type: 'chunk' | 'manifest', opts: { times?: number; byteOffset?: number; bit?: number; filter?: (bytes: Uint8Array) => boolean } = {}): void {
    const offset = opts.byteOffset ?? (type === 'chunk' ? CHUNK_PAYLOAD_OFFSET : MANIFEST_PAYLOAD_OFFSET);
    this.corruptNext(
      (b) => laneType(b) === type && b.length > offset && (opts.filter?.(b) ?? true),
      (b) => flipBit(b, offset, opts.bit ?? 0),
      opts.times ?? 1,
    );
  }

  clearRules(): void {
    this.rules = [];
  }

  install(transport: MemoryTransport): void {
    const orig = transport.send.bind(transport);
    transport.send = async (peerId, bytes) => {
      if (!isLane(bytes)) return orig(peerId, bytes);
      this.stats.seen++;
      this.sent.push({ from: transport.name, to: peerId, bytes: bytes.slice() });
      let out = bytes;
      const rule = this.rules.find((r) => r.remaining > 0 && r.match(out));
      if (rule) {
        rule.remaining--;
        out = rule.mutate(out);
        this.stats.corrupted++;
      }
      if (!this.affect(bytes)) return orig(peerId, out);
      if (this.rnd() < this.dropRate) {
        this.stats.dropped++;
        return;
      }
      const copies = this.rnd() < this.dupRate ? 2 : 1;
      if (copies === 2) this.stats.duplicated++;
      const wait = this.delayMs + (this.jitterMs ? Math.floor(this.rnd() * this.jitterMs) : 0);
      for (let i = 0; i < copies; i++) {
        if (wait > 0) {
          this.stats.delayed++;
          setTimeout(() => void orig(peerId, out).catch(() => undefined), wait);
        } else {
          await orig(peerId, out);
        }
      }
    };
  }

  /** Lane messages sent so far, optionally only of one type. */
  count(type?: LaneTypeName, from?: string): number {
    return this.sent.filter((s) => (type === undefined || laneType(s.bytes) === type) && (from === undefined || s.from === from)).length;
  }
}
