/** Abuse limits for the link (contracts/bluetooth-link.md "Abuse limits (Hub)"): a sliding-window counter. */

export class SlidingCounter {
  private times: number[] = [];
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /** Count one event at `now`. Returns true if it is allowed (within the limit). */
  allow(now: number): boolean {
    this.times = this.times.filter((t) => now - t < this.windowMs);
    if (this.times.length >= this.max) return false;
    this.times.push(now);
    return true;
  }
}

export const HANDSHAKES_PER_MINUTE_PER_DEVICE = 6;
export const HANDSHAKES_PER_MINUTE_OVERALL = 30;

/** Per-device and overall handshake limits. Overall is checked at `hello` (before any crypto); per-device at `auth` (when the device is proven). */
export class HandshakeLimiter {
  private readonly overall = new SlidingCounter(HANDSHAKES_PER_MINUTE_OVERALL, 60_000);
  private readonly byDevice = new Map<string, SlidingCounter>();

  allowHello(now: number): boolean {
    return this.overall.allow(now);
  }

  allowDevice(device: string, now: number): boolean {
    let c = this.byDevice.get(device);
    if (!c) {
      if (this.byDevice.size > 1000) this.byDevice.clear(); // bounded memory
      this.byDevice.set(device, (c = new SlidingCounter(HANDSHAKES_PER_MINUTE_PER_DEVICE, 60_000)));
    }
    return c.allow(now);
  }
}
