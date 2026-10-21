/**
 * Hybrid logical clock. A clock string is `wwwwwwwwwwww-cccc-<deviceId>`: 48-bit wall time in
 * milliseconds and a 16-bit counter as fixed-width lowercase hex, then the device ID. Plain string
 * comparison is clock order, and the device ID is the deterministic tiebreaker (FR-007).
 */

export interface ParsedClock {
  wall: number;
  counter: number;
  device: string;
}

const MAX_COUNTER = 0xffff;
const CLOCK_RE = /^([0-9a-f]{12})-([0-9a-f]{4})-([A-Za-z0-9_]+)$/;

export function formatClock(wall: number, counter: number, device: string): string {
  return `${wall.toString(16).padStart(12, '0')}-${counter.toString(16).padStart(4, '0')}-${device}`;
}

export function parseClock(s: string): ParsedClock | null {
  const m = CLOCK_RE.exec(s);
  if (!m) return null;
  return { wall: parseInt(m[1]!, 16), counter: parseInt(m[2]!, 16), device: m[3]! };
}

export function compareClock(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function maxClock(a: string, b: string): string {
  return a >= b ? a : b;
}

/** A clock strictly greater than `clock`, owned by `device` (the causal bump for local writes). */
export function nextAfter(clock: string, device: string): string {
  const c = parseClock(clock);
  if (!c) throw new Error(`malformed clock: ${clock}`);
  return c.counter >= MAX_COUNTER ? formatClock(c.wall + 1, 0, device) : formatClock(c.wall, c.counter + 1, device);
}

export interface HlcState {
  wall: number;
  counter: number;
}

export class HLC {
  private wall: number;
  private counter: number;

  constructor(
    readonly device: string,
    private readonly now: () => number,
    private readonly maxDriftMs: number,
    initial?: HlcState,
  ) {
    this.wall = initial?.wall ?? 0;
    this.counter = initial?.counter ?? 0;
  }

  state(): HlcState {
    return { wall: this.wall, counter: this.counter };
  }

  /** Next clock for a local event. Strictly monotonic. */
  tick(): string {
    const pt = this.now();
    if (pt > this.wall) {
      this.wall = pt;
      this.counter = 0;
    } else if (this.counter >= MAX_COUNTER) {
      this.wall += 1;
      this.counter = 0;
    } else {
      this.counter += 1;
    }
    return formatClock(this.wall, this.counter, this.device);
  }

  /**
   * Observe a remote clock. The effective remote wall time is capped at `now + maxDrift`, so a far-future
   * clock cannot drag ours forward (FR-008). The packet itself is still applied with its own clock.
   */
  receive(remote: string): void {
    const r = parseClock(remote);
    if (!r) return;
    const rw = Math.min(r.wall, this.now() + this.maxDriftMs);
    const rc = rw === r.wall ? r.counter : 0;
    if (rw > this.wall) {
      this.wall = rw;
      this.counter = rc;
    } else if (rw === this.wall && rc > this.counter) {
      this.counter = rc;
    }
  }
}
