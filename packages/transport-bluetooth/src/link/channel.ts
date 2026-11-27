/**
 * LinkChannel: one end of a link/1 connection above the radio. It joins the frame scheduler, the secure session, and the control and
 * core message kinds, and keeps receive processing in order (the replay window needs messages opened in the order they arrived).
 * The client and the Hub both use it; they differ only in the handshake and in what they do with the messages.
 */

import { Kind } from './handshake';
import { decodeInner, encodeControl, encodeCore, type ControlMessage } from './control';
import { LinkFramer } from './scheduler';
import type { LinkSession } from './session';
import type { Stream } from './frames';

export interface ChannelHandlers {
  /** A plaintext handshake message (kind 0xF0 or 0xF1), only accepted before a session exists. */
  plain?(msg: Uint8Array): void | Promise<void>;
  control(msg: { t: string } & Record<string, unknown>): void | Promise<void>;
  core(bytes: Uint8Array, stream: Stream): void | Promise<void>;
  /** Something that should count against the peer: a bad frame, a message that fails to authenticate, an unknown kind. */
  strike(reason: string): void;
  /** A PROBE frame arrived (its length). */
  probe?(frameBytes: number): void;
}

export interface ChannelOptions {
  maxMessageBytes: number;
  frameBytes?: number;
  write(frame: Uint8Array): void | Promise<void>;
  now(): number;
  onWriteFailed?(): void;
  handlers: ChannelHandlers;
}

export class LinkChannel {
  readonly framer: LinkFramer;
  private session: LinkSession | undefined;
  private rx: Promise<void> = Promise.resolve();
  private tx: Promise<void> = Promise.resolve();

  constructor(private readonly o: ChannelOptions) {
    this.framer = new LinkFramer({
      maxMessageBytes: o.maxMessageBytes,
      ...(o.frameBytes !== undefined ? { frameBytes: o.frameBytes } : {}),
      write: o.write,
      now: o.now,
      ...(o.onWriteFailed ? { onWriteFailed: o.onWriteFailed } : {}),
    });
  }

  setSession(s: LinkSession): void {
    this.session = s;
  }
  hasSession(): boolean {
    return this.session !== undefined;
  }

  /** A handshake message in the clear (stream 0). */
  sendPlain(bytes: Uint8Array): void {
    this.framer.enqueue(0, bytes);
  }

  sendControl(msg: ControlMessage): Promise<void> {
    return this.enqueueSealed(encodeControl(msg), 0);
  }

  /** A core message (a sync-protocol message, or a lane message beginning with a registered magic). Lane messages ride stream 1. */
  sendCore(bytes: Uint8Array): Promise<void> {
    return this.enqueueSealed(encodeCore(bytes), bytes.length > 0 && bytes[0]! >= 0x80 ? 1 : 0);
  }

  private enqueueSealed(inner: Uint8Array, stream: Stream): Promise<void> {
    const run = this.tx.then(async () => {
      const s = this.session;
      if (!s) throw new Error('link is not secured yet');
      this.framer.enqueue(stream, await s.seal(inner, undefined, stream));
    });
    this.tx = run.catch(() => undefined);
    return run;
  }

  /** Feed one received frame (a GATT write on the Hub, a notification on the client). Processed in arrival order. */
  onFrame(bytes: Uint8Array): Promise<void> {
    const run = this.rx.then(() => this.process(bytes));
    this.rx = run.catch(() => undefined);
    return run;
  }

  /** Resolves once everything received so far has been handled. */
  async settled(): Promise<void> {
    await this.rx;
    await this.tx;
  }

  private async process(bytes: Uint8Array): Promise<void> {
    const h = this.o.handlers;
    const r = await this.framer.receive(bytes);
    if (r.bad) h.strike('bad-frame');
    for (const e of r.errors) h.strike(e);
    if (r.probe !== undefined) h.probe?.(r.probe);
    for (const m of r.messages) {
      const kind = m.bytes[0];
      if (kind === Kind.HELLO || kind === Kind.HELLO_ACK) {
        if (this.session || !h.plain) h.strike('unexpected-plaintext');
        else await h.plain(m.bytes);
      } else if (kind === Kind.ENCRYPTED) {
        if (!this.session) {
          h.strike('encrypted-before-handshake');
          continue;
        }
        const inner = await this.session.open(m.bytes, m.stream);
        if (!inner) {
          h.strike('bad-message');
          continue;
        }
        const d = decodeInner(inner);
        if (!d) h.strike('bad-inner');
        else if (d.kind === 'control') await h.control(d.msg);
        else await h.core(d.bytes, m.stream);
      } else {
        h.strike('unknown-kind');
      }
    }
  }
}
