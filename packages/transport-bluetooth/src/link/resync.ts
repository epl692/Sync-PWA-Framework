/**
 * Resync coordination (contracts/bluetooth-link.md, control `resync`): when a message is lost, both sides restart the sync handshake.
 * The `resync` message itself can be lost, so it carries an id, is acknowledged, and is retried; if it is never acknowledged the
 * link is closed so a full reconnect repairs it.
 */

import type { ControlMessage } from './control';

export interface ResyncTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
}

export interface ResyncOptions {
  send(msg: ControlMessage): void;
  /** Restart the sync handshake on this side (the transport announces the peer as gone and back, the Hub resets the relay's view). */
  bounce(): void;
  /** Never acknowledged after all retries: close the link. */
  failed(): void;
  timers: ResyncTimers;
  now(): number;
  retryMs?: number;
  maxTries?: number;
  /** Losses detected within this many ms of the last one are folded into it. */
  coalesceMs?: number;
}

export class Resync {
  private nextId = 1;
  private seen = new Set<number>();
  private inflight: { id: number; tries: number; timer: unknown } | undefined;
  private last = -Infinity;
  private disposed = false;
  private trailing = false;

  constructor(private readonly o: ResyncOptions) {}

  /** A message was lost on this link. */
  detected(): void {
    if (this.disposed) return;
    const t = this.o.now();
    const window = this.o.coalesceMs ?? 500;
    if (t - this.last < window) {
      // a loss right after a restart may be of something the restart itself sent: run once more when the window ends
      if (!this.trailing) {
        this.trailing = true;
        this.o.timers.setTimeout(() => {
          this.trailing = false;
          this.detected();
        }, window - (t - this.last) + 1);
      }
      return;
    }
    this.last = t;
    // `resync` goes out BEFORE this side's fresh hello, so the peer restarts first and then hears our hello (never the other way round)
    this.start();
    this.o.bounce();
  }

  private start(): void {
    if (this.inflight) this.o.timers.clearTimeout(this.inflight.timer);
    const id = this.nextId++;
    this.inflight = { id, tries: 0, timer: undefined };
    this.attempt();
  }

  private attempt(): void {
    const f = this.inflight;
    if (!f || this.disposed) return;
    if (f.tries >= (this.o.maxTries ?? 5)) {
      this.inflight = undefined;
      this.o.failed();
      return;
    }
    f.tries++;
    this.o.send({ t: 'resync', id: f.id });
    f.timer = this.o.timers.setTimeout(() => this.attempt(), this.o.retryMs ?? 1500);
  }

  /** Feed `resync` and `resync-ack` control messages. */
  onMessage(m: { t: string; id?: unknown }): void {
    if (this.disposed || typeof m.id !== 'number') return;
    if (m.t === 'resync') {
      this.o.send({ t: 'resync-ack', id: m.id }); // always acknowledge, so a retry stops
      if (this.seen.has(m.id)) return;
      this.seen.add(m.id);
      if (this.seen.size > 64) this.seen.delete(this.seen.values().next().value as number);
      this.last = this.o.now();
      this.o.bounce();
    } else if (m.t === 'resync-ack' && this.inflight?.id === m.id) {
      this.o.timers.clearTimeout(this.inflight.timer);
      this.inflight = undefined;
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.inflight) this.o.timers.clearTimeout(this.inflight.timer);
    this.inflight = undefined;
  }
}
