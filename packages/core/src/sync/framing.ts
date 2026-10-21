/**
 * Shared framing for transports whose messages are limited in size (WebRTC data channels, and any
 * future byte-pipe transport). Frame layout, big-endian:
 *   version u8 | messageId u32 | index u16 | total u16 | payloadLength u32 | payload | crc32 u32
 * The CRC covers everything before it, so a damaged frame is rejected on its own.
 */

export class FrameError extends Error {
  constructor(
    readonly code: 'too-short' | 'version' | 'corrupt' | 'length' | 'too-large' | 'range',
    message: string,
  ) {
    super(message);
    this.name = 'FrameError';
  }
}

const VERSION = 1;
const HEADER = 1 + 4 + 2 + 2 + 4;
const TRAILER = 4;
export const FRAME_OVERHEAD = HEADER + TRAILER;

let crcTable: Uint32Array | undefined;
export function crc32(bytes: Uint8Array, end = bytes.length): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < end; i++) c = crcTable[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

let counter = 0;
function newMessageId(): number {
  const b = new Uint32Array(1);
  globalThis.crypto.getRandomValues(b);
  return (b[0]! ^ counter++) >>> 0;
}

/** Split one message into frames no larger than `maxFrameBytes`. */
export function chunk(message: Uint8Array, maxFrameBytes: number): Uint8Array[] {
  const per = maxFrameBytes - FRAME_OVERHEAD;
  if (per < 1) throw new RangeError('maxFrameBytes is too small for the frame header');
  const total = Math.max(1, Math.ceil(message.length / per));
  if (total > 0xffff) throw new RangeError('message needs more than 65535 frames');
  const id = newMessageId();
  const frames: Uint8Array[] = [];
  for (let i = 0; i < total; i++) {
    const payload = message.subarray(i * per, Math.min(message.length, (i + 1) * per));
    const f = new Uint8Array(HEADER + payload.length + TRAILER);
    const v = new DataView(f.buffer);
    v.setUint8(0, VERSION);
    v.setUint32(1, id);
    v.setUint16(5, i);
    v.setUint16(7, total);
    v.setUint32(9, payload.length);
    f.set(payload, HEADER);
    v.setUint32(HEADER + payload.length, crc32(f, HEADER + payload.length));
    frames.push(f);
  }
  return frames;
}

export interface ReassemblerOptions {
  /** Refuse messages larger than this. Default 64 MiB. */
  maxMessageBytes?: number;
  /** Keep at most this many incomplete messages; the oldest are dropped. Default 32. */
  maxPending?: number;
}

interface Pending {
  total: number;
  parts: Map<number, Uint8Array>;
}

export class Reassembler {
  private pending = new Map<number, Pending>();
  private readonly maxMessageBytes: number;
  private readonly maxPending: number;

  constructor(opts: ReassemblerOptions = {}) {
    this.maxMessageBytes = opts.maxMessageBytes ?? 64 * 1024 * 1024;
    this.maxPending = opts.maxPending ?? 32;
  }

  /** Feed one frame. Returns the complete message when its last frame arrives, otherwise undefined. */
  push(frame: Uint8Array): Uint8Array | undefined {
    if (frame.length < FRAME_OVERHEAD) throw new FrameError('too-short', `frame of ${frame.length} bytes`);
    const v = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    const payloadLen = v.getUint32(9);
    if (HEADER + payloadLen + TRAILER !== frame.length) throw new FrameError('length', 'frame length does not match its header');
    if (crc32(frame, frame.length - TRAILER) !== v.getUint32(frame.length - TRAILER)) throw new FrameError('corrupt', 'CRC mismatch');
    if (v.getUint8(0) !== VERSION) throw new FrameError('version', `unsupported frame version ${v.getUint8(0)}`);
    const id = v.getUint32(1);
    const index = v.getUint16(5);
    const total = v.getUint16(7);
    if (total < 1 || index >= total) throw new FrameError('range', 'frame index out of range');
    if (index < total - 1 && (total - 1) * payloadLen > this.maxMessageBytes) throw new FrameError('too-large', 'message exceeds the size limit');

    const payload = frame.slice(HEADER, HEADER + payloadLen);
    if (total === 1) return payload;

    let p = this.pending.get(id);
    if (!p) {
      p = { total, parts: new Map() };
      this.pending.set(id, p);
      while (this.pending.size > this.maxPending) this.pending.delete(this.pending.keys().next().value!);
    }
    if (p.total !== total) throw new FrameError('range', 'frame total changed within a message');
    p.parts.set(index, payload);
    if (p.parts.size < p.total) return undefined;

    this.pending.delete(id);
    let size = 0;
    for (const part of p.parts.values()) size += part.length;
    if (size > this.maxMessageBytes) throw new FrameError('too-large', 'message exceeds the size limit');
    const out = new Uint8Array(size);
    let at = 0;
    for (let i = 0; i < p.total; i++) {
      const part = p.parts.get(i)!;
      out.set(part, at);
      at += part.length;
    }
    return out;
  }

  /** Number of messages waiting for more frames. */
  get incomplete(): number {
    return this.pending.size;
  }
}
