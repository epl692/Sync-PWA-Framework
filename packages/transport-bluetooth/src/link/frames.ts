/**
 * link/1 frames (specs/005-bluetooth-transport/contracts/bluetooth-link.md#frames). Pure: no radio, no browser API.
 *
 *   byte 0:  bits 7-6 type (00 DATA, 01 ACK, 10 PROBE, 11 reserved) | bit 5 stream | bit 4 START | bit 3 END | bits 2-0 reserved (sent as 0)
 *   byte 1:  seq (8-bit, per stream and direction)
 */

export const FrameType = { DATA: 0, ACK: 1, PROBE: 2 } as const;
export type FrameTypeValue = (typeof FrameType)[keyof typeof FrameType];
export type Stream = 0 | 1;

export interface Frame {
  type: FrameTypeValue;
  stream: Stream;
  start: boolean;
  end: boolean;
  seq: number;
  payload: Uint8Array;
}

export const FRAME_HEADER_BYTES = 2;
/** The reassembly allowance on top of `maxMessageBytes` for the counter (8 B) and the AES-GCM tag (16 B). */
export const MESSAGE_OVERHEAD_BYTES = 24;
export const REASSEMBLY_TIMEOUT_MS = 30_000;

export function encodeFrame(f: Frame): Uint8Array {
  const out = new Uint8Array(FRAME_HEADER_BYTES + f.payload.length);
  out[0] = (f.type << 6) | (f.stream << 5) | (f.start ? 0x10 : 0) | (f.end ? 0x08 : 0);
  out[1] = f.seq & 0xff;
  out.set(f.payload, FRAME_HEADER_BYTES);
  return out;
}

/** Null for a frame shorter than the header or of the reserved type. Reserved bits are ignored. */
export function decodeFrame(b: Uint8Array): Frame | null {
  if (b.length < FRAME_HEADER_BYTES) return null;
  const type = b[0]! >> 6;
  if (type === 3) return null;
  return {
    type: type as FrameTypeValue,
    stream: ((b[0]! >> 5) & 1) as Stream,
    start: (b[0]! & 0x10) !== 0,
    end: (b[0]! & 0x08) !== 0,
    seq: b[1]!,
    payload: b.slice(FRAME_HEADER_BYTES),
  };
}

/** Split one message into DATA frames of at most `frameBytes` (header included), consecutive wrapping `seq` from `seqStart`. */
export function splitMessage(message: Uint8Array, frameBytes: number, stream: Stream, seqStart: number): Frame[] {
  const room = frameBytes - FRAME_HEADER_BYTES;
  if (room < 1) throw new RangeError('frameBytes too small');
  const frames: Frame[] = [];
  const n = Math.max(1, Math.ceil(message.length / room));
  for (let i = 0; i < n; i++) {
    frames.push({
      type: FrameType.DATA,
      stream,
      start: i === 0,
      end: i === n - 1,
      seq: (seqStart + i) & 0xff,
      payload: message.slice(i * room, (i + 1) * room),
    });
  }
  return frames;
}

export type ReassembleError = 'frame-gap' | 'start-in-message' | 'no-start' | 'oversize';

/** Errors that mean a message was lost (as opposed to hostile or merely noisy input): the layer above should resynchronise. */
export const MESSAGE_LOST: ReadonlySet<ReassembleError> = new Set(['frame-gap', 'start-in-message', 'oversize']);

export interface PushResult {
  message?: Uint8Array;
  error?: ReassembleError;
}

interface StreamState {
  expect: number | undefined;
  parts: Uint8Array[];
  size: number;
  startedAt: number;
  inMessage: boolean;
  skipping: boolean;
}

const fresh = (): StreamState => ({ expect: undefined, parts: [], size: 0, startedAt: 0, inMessage: false, skipping: false });

/** Rebuilds messages from DATA frames, per stream. A gap or duplicate aborts only the message in progress. */
export class Reassembler {
  private readonly st: [StreamState, StreamState] = [fresh(), fresh()];
  private readonly max: number;
  private readonly timeout: number;

  constructor(o: { maxMessageBytes: number; timeoutMs?: number }) {
    this.max = o.maxMessageBytes + MESSAGE_OVERHEAD_BYTES;
    this.timeout = o.timeoutMs ?? REASSEMBLY_TIMEOUT_MS;
  }

  private abort(s: StreamState): void {
    s.parts = [];
    s.size = 0;
    s.inMessage = false;
  }

  push(f: Frame, now: number): PushResult {
    if (f.type !== FrameType.DATA) return {};
    const s = this.st[f.stream];
    let error: ReassembleError | undefined;

    // a frame we already have (a duplicate from the radio) is dropped; it cannot corrupt anything
    if (s.expect !== undefined && f.seq === ((s.expect - 1) & 0xff)) return {};
    if (s.expect !== undefined && f.seq !== s.expect) {
      error = 'frame-gap'; // data went missing: a message in progress, or whole messages between this one and the last
      this.abort(s);
      s.expect = undefined;
      s.skipping = true;
    }
    if (f.start) {
      if (s.inMessage) {
        error = 'start-in-message';
        this.abort(s);
      }
      s.skipping = false;
      s.inMessage = true;
      s.parts = [];
      s.size = 0;
      s.startedAt = now;
    } else if (!s.inMessage) {
      s.expect = (f.seq + 1) & 0xff; // keep counting through frames we are skipping
      if (s.skipping) return error ? { error } : {};
      s.skipping = true;
      return { error: error ?? 'no-start' };
    }

    s.expect = (f.seq + 1) & 0xff;
    s.parts.push(f.payload);
    s.size += f.payload.length;
    if (s.size > this.max) {
      this.abort(s);
      s.skipping = true;
      return { error: 'oversize' };
    }
    if (!f.end) return error ? { error } : {};

    const message = new Uint8Array(s.size);
    let o = 0;
    for (const p of s.parts) {
      message.set(p, o);
      o += p.length;
    }
    this.abort(s);
    return error ? { message, error } : { message };
  }

  /** Drop partial messages that have been open longer than the timeout. Returns the streams that were dropped. */
  expire(now: number): Stream[] {
    const dropped: Stream[] = [];
    this.st.forEach((s, i) => {
      if (s.inMessage && now - s.startedAt >= this.timeout) {
        this.abort(s);
        s.expect = undefined;
        s.skipping = false;
        dropped.push(i as Stream);
      }
    });
    return dropped;
  }
}

/** Counts strikes (bad frames, protocol violations) inside a sliding window; `record` returns true once the limit is reached. */
export class StrikeWindow {
  private times: number[] = [];
  constructor(
    private readonly limit = 3,
    private readonly windowMs = 10_000,
  ) {}
  record(now: number): boolean {
    this.times = this.times.filter((t) => now - t < this.windowMs);
    this.times.push(now);
    return this.times.length >= this.limit;
  }
  reset(): void {
    this.times = [];
  }
}
