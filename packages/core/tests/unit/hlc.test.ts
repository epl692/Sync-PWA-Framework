import { describe, expect, it } from 'vitest';
import { HLC, compareClock, formatClock, nextAfter, parseClock } from '../../src/clock/hlc';

const DEV = 'AAAAAAAAAAAAAAAAAAAAAAAAAA';

describe('clock format', () => {
  it('is fixed width wwwwwwwwwwww-cccc-<device>', () => {
    expect(formatClock(1, 2, DEV)).toBe(`000000000001-0002-${DEV}`);
    expect(parseClock(`000000000001-0002-${DEV}`)).toEqual({ wall: 1, counter: 2, device: DEV });
  });

  it('rejects malformed clocks', () => {
    for (const bad of ['', 'x', '000000000001-0002', '00000000000G-0002-A', '000000000001-002-A', '000000000001-0002-']) {
      expect(parseClock(bad), bad).toBeNull();
    }
  });

  it('string order equals clock order, device id breaks ties', () => {
    const a = formatClock(5, 0, 'A');
    const b = formatClock(5, 0, 'B');
    const c = formatClock(5, 1, 'A');
    const d = formatClock(6, 0, 'A');
    expect([d, c, b, a].sort(compareClock)).toEqual([a, b, c, d]);
  });

  it('keeps order across hex digit rollovers', () => {
    const lo = formatClock(0xff, 0, 'A');
    const hi = formatClock(0x100, 0, 'A');
    expect(compareClock(lo, hi)).toBeLessThan(0);
  });
});

describe('HLC', () => {
  it('tick is strictly monotonic even when wall time stalls or goes backwards', () => {
    let now = 1000;
    const h = new HLC(DEV, () => now, 300_000);
    const seen: string[] = [];
    for (let i = 0; i < 5; i++) seen.push(h.tick());
    now = 500; // clock jumped back
    for (let i = 0; i < 5; i++) seen.push(h.tick());
    for (let i = 1; i < seen.length; i++) expect(compareClock(seen[i - 1]!, seen[i]!)).toBeLessThan(0);
  });

  it('follows wall time forward and resets the counter', () => {
    let now = 1000;
    const h = new HLC(DEV, () => now, 300_000);
    h.tick();
    now = 2000;
    expect(parseClock(h.tick())).toMatchObject({ wall: 2000, counter: 0 });
  });

  it('receive moves the clock past a nearby remote clock', () => {
    const now = 1000;
    const h = new HLC(DEV, () => now, 300_000);
    h.receive(formatClock(1100, 4, 'B'));
    expect(compareClock(h.tick(), formatClock(1100, 4, 'B'))).toBeGreaterThan(0);
  });

  it('never advances beyond now + maxDrift because of a remote clock (FR-008)', () => {
    const now = 1_000_000;
    const maxDrift = 300_000;
    const h = new HLC(DEV, () => now, maxDrift);
    h.receive(formatClock(now + 3_600_000, 0, 'B')); // one hour ahead
    expect(parseClock(h.tick())!.wall).toBeLessThanOrEqual(now + maxDrift);
  });

  it('snapshots and restores its state', () => {
    const now = 1000;
    const h = new HLC(DEV, () => now, 300_000);
    h.tick();
    h.tick();
    const state = h.state();
    const h2 = new HLC(DEV, () => now, 300_000, state);
    expect(compareClock(h2.tick(), formatClock(state.wall, state.counter, DEV))).toBeGreaterThan(0);
  });

  it('nextAfter returns a clock strictly greater than the input, owned by our device', () => {
    const remote = formatClock(9000, 65535, 'ZZZ');
    const n = nextAfter(remote, DEV);
    expect(compareClock(n, remote)).toBeGreaterThan(0);
    expect(parseClock(n)!.device).toBe(DEV);
    const m = nextAfter(formatClock(9000, 3, 'ZZZ'), DEV);
    expect(parseClock(m)).toMatchObject({ wall: 9000, counter: 4 });
  });
});
