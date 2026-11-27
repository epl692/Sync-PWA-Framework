/**
 * link/1 flow control (contracts/bluetooth-link.md#frames): a per-stream window of 32 unacknowledged DATA frames, ACK every 16
 * frames and at END, packets (stream 0) preferred over bulk (stream 1) with the bulk stream guaranteed a turn, frame-size
 * probing, and halving of the frame size on write errors. No radio: the caller supplies `write`.
 */

import {
  FRAME_HEADER_BYTES,
  FrameType,
  Reassembler,
  decodeFrame,
  encodeFrame,
  type ReassembleError,
  type Stream,
} from './frames';

export const SAFE_FRAME_BYTES = 20;
export const MAX_FRAME_BYTES = 244;
export const PROBE_LADDER = [64, 128, 182, 244] as const;
export const PROBE_SPACING_MS = 50;
const WINDOW = 32;
const ACK_EVERY = 16;
/** After this many consecutive stream-0 frames, a waiting stream-1 frame gets a turn. */
const STREAM0_RUN = 8;
const WRITE_FAILURES_AT_FLOOR = 3;

export function makeProbeFrame(totalBytes: number): Uint8Array {
  return encodeFrame({ type: FrameType.PROBE, stream: 0, start: false, end: false, seq: 0, payload: new Uint8Array(Math.max(0, totalBytes - FRAME_HEADER_BYTES)) });
}

/** Client: send the probe ladder, `PROBE_SPACING_MS` apart. */
export async function sendProbes(write: (b: Uint8Array) => void | Promise<void>, sleep: (ms: number) => Promise<void>): Promise<void> {
  for (let i = 0; i < PROBE_LADDER.length; i++) {
    if (i > 0) await sleep(PROBE_SPACING_MS);
    await write(makeProbeFrame(PROBE_LADDER[i]!));
  }
}

/** Hub: remember the size of each probe frame that arrived. */
export class ProbeCollector {
  private sizes = new Set<number>();
  onProbe(frameBytes: Uint8Array): void {
    const f = decodeFrame(frameBytes);
    if (f?.type === FrameType.PROBE) this.sizes.add(frameBytes.length);
  }
  /** Record a probe by its frame length (when the framer already decoded it). */
  onProbeLength(n: number): void {
    this.sizes.add(n);
  }
  received(): number[] {
    return [...this.sizes].sort((a, b) => a - b);
  }
  clear(): void {
    this.sizes.clear();
  }
}

/** Client write frame size: `min(largest probe the Hub received, the Hub's notify limit)`, never below 20 or above 244. */
export function chooseFrameBytes(received: number[], hubNotify: number): number {
  const largest = received.length ? Math.max(...received) : SAFE_FRAME_BYTES;
  return Math.max(SAFE_FRAME_BYTES, Math.min(largest, hubNotify, MAX_FRAME_BYTES));
}

export interface FramerOptions {
  maxMessageBytes: number;
  frameBytes?: number;
  window?: number;
  write(frame: Uint8Array): void | Promise<void>;
  now(): number;
  /** Even 20-byte frames cannot be written: the link should close. */
  onWriteFailed?(): void;
}

export interface ReceiveResult {
  messages: Array<{ stream: Stream; bytes: Uint8Array }>;
  errors: ReassembleError[];
  /** True if the bytes were not a valid frame. */
  bad: boolean;
  /** Set when the frame was a PROBE (the frame length, for `ProbeCollector`). */
  probe?: number;
}

interface Out {
  queue: Uint8Array[];
  offset: number;
  nextSeq: number;
  ackedNext: number;
  /** When the oldest unacknowledged frame was sent (or when an ACK last made progress). */
  unackedSince: number;
}

/** Both directions of one link: queues outgoing messages into frames, reassembles incoming ones, and acks. */
export class LinkFramer {
  frameBytes: number;
  private readonly window: number;
  private readonly out: [Out, Out] = [
    { queue: [], offset: 0, nextSeq: 0, ackedNext: 0, unackedSince: 0 },
    { queue: [], offset: 0, nextSeq: 0, ackedNext: 0, unackedSince: 0 },
  ];
  private readonly rea: Reassembler;
  private readonly recvSinceAck: [number, number] = [0, 0];
  private last: Stream = 0;
  private run = 0;
  private failures = 0;
  private pumping: Promise<void> | undefined;
  private again = false;
  private dead = false;

  constructor(private readonly o: FramerOptions) {
    this.frameBytes = Math.min(Math.max(o.frameBytes ?? SAFE_FRAME_BYTES, SAFE_FRAME_BYTES), MAX_FRAME_BYTES);
    this.window = o.window ?? WINDOW;
    this.rea = new Reassembler({ maxMessageBytes: o.maxMessageBytes });
  }

  /** Queue a message and send what the window allows. Resolves when nothing more can be written right now. */
  async send(stream: Stream, message: Uint8Array): Promise<void> {
    if (this.dead) return;
    this.out[stream].queue.push(message);
    await this.pump();
  }

  /** Queue a message without waiting for the window: the caller does not block behind a full window. */
  enqueue(stream: Stream, message: Uint8Array): void {
    if (this.dead) return;
    this.out[stream].queue.push(message);
    void this.pump();
  }

  /** Resolves once the pump has nothing left it is able to send. */
  async idle(): Promise<void> {
    while (this.pumping) await this.pumping;
  }

  /** True if frames have been waiting for an ACK for at least `ms`: the radio dropped something (even the last frame of a burst). */
  stalled(now: number, ms: number): boolean {
    return ([0, 1] as const).some((s) => this.inflight(s) > 0 && now - this.out[s].unackedSince >= ms);
  }

  /** After a loss was handled: stop waiting for frames that will never be acknowledged, so the window frees up. */
  forgetUnacked(): void {
    for (const s of [0, 1] as const) this.out[s].ackedNext = this.out[s].nextSeq;
    void this.pump();
  }

  /** Messages queued or partly sent, per stream (a measure of backlog). */
  backlog(): [number, number] {
    return [this.out[0].queue.length, this.out[1].queue.length];
  }

  expire(now: number): Stream[] {
    return this.rea.expire(now);
  }

  private inflight(s: Stream): number {
    return (this.out[s].nextSeq - this.out[s].ackedNext) & 0xff;
  }

  private eligible(s: Stream): boolean {
    return this.out[s].queue.length > 0 && this.inflight(s) < this.window;
  }

  private pick(): Stream | undefined {
    const e0 = this.eligible(0);
    const e1 = this.eligible(1);
    if (e0 && e1) {
      if (this.last === 0 && this.run >= STREAM0_RUN) return 1;
      return 0;
    }
    return e0 ? 0 : e1 ? 1 : undefined;
  }

  private pump(): Promise<void> {
    if (this.pumping) {
      this.again = true;
      return this.pumping;
    }
    this.pumping = (async () => {
      try {
        do {
          this.again = false;
          while (!this.dead && (await this.sendNext())) {
            /* keep going */
          }
        } while (this.again && !this.dead);
      } finally {
        this.pumping = undefined;
      }
    })();
    return this.pumping;
  }

  private async sendNext(): Promise<boolean> {
    const s = this.pick();
    if (s === undefined) return false;
    const st = this.out[s];
    const msg = st.queue[0]!;
    const room = this.frameBytes - FRAME_HEADER_BYTES;
    const payload = msg.slice(st.offset, st.offset + room);
    const end = st.offset + room >= msg.length;
    const bytes = encodeFrame({ type: FrameType.DATA, stream: s, start: st.offset === 0, end, seq: st.nextSeq, payload });
    try {
      await this.o.write(bytes);
    } catch {
      if (this.frameBytes > SAFE_FRAME_BYTES) {
        this.frameBytes = Math.max(SAFE_FRAME_BYTES, Math.floor(this.frameBytes / 2));
        return true; // retry the same data with a smaller frame
      }
      if (++this.failures >= WRITE_FAILURES_AT_FLOOR) {
        this.dead = true;
        this.out[0].queue = [];
        this.out[1].queue = [];
        this.o.onWriteFailed?.();
        return false;
      }
      return true;
    }
    this.failures = 0;
    if (this.inflight(s) === 0) st.unackedSince = this.o.now();
    st.nextSeq = (st.nextSeq + 1) & 0xff;
    if (end) {
      st.queue.shift();
      st.offset = 0;
    } else {
      st.offset += room;
    }
    this.run = this.last === s ? this.run + 1 : 1;
    this.last = s;
    return true;
  }

  /** Feed one received frame (a GATT write or notification). */
  async receive(bytes: Uint8Array): Promise<ReceiveResult> {
    const res: ReceiveResult = { messages: [], errors: [], bad: false };
    const f = decodeFrame(bytes);
    if (!f) {
      res.bad = true;
      return res;
    }
    if (f.type === FrameType.PROBE) {
      res.probe = bytes.length;
      return res;
    }
    if (f.type === FrameType.ACK) {
      this.onAck(f.stream, f.payload[0]);
      await this.pump();
      return res;
    }
    const r = this.rea.push(f, this.o.now());
    if (r.error) res.errors.push(r.error);
    if (r.message) res.messages.push({ stream: f.stream, bytes: r.message });
    if (++this.recvSinceAck[f.stream] >= ACK_EVERY || f.end) {
      this.recvSinceAck[f.stream] = 0;
      try {
        await this.o.write(encodeFrame({ type: FrameType.ACK, stream: f.stream, start: false, end: false, seq: 0, payload: Uint8Array.of(f.seq) }));
      } catch {
        /* a lost ACK only delays the sender; the next ACK covers it */
      }
    }
    return res;
  }

  private onAck(stream: Stream, highest: number | undefined): void {
    if (highest === undefined) return;
    const st = this.out[stream];
    const advance = ((highest + 1) & 0xff) - st.ackedNext;
    const n = ((advance % 256) + 256) % 256;
    if (n > this.inflight(stream)) return; // stale or bogus
    st.ackedNext = (highest + 1) & 0xff;
    st.unackedSince = this.o.now(); // progress
  }
}
