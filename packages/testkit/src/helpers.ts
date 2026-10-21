import { newId, type RandomBytes } from '@sync/core';

export interface FakeClock {
  now(): number;
  set(ms: number): void;
  advance(ms: number): void;
}

export function createFakeClock(start = 1_700_000_000_000): FakeClock {
  let t = start;
  return {
    now: () => t,
    set: (ms) => void (t = ms),
    advance: (ms) => void (t += ms),
  };
}

/** Deterministic PRNG (mulberry32). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededBytes(seed: number): RandomBytes {
  const rnd = seededRandom(seed);
  return (n) => Uint8Array.from({ length: n }, () => Math.floor(rnd() * 256));
}

/** A stable, readable device ID for tests: base32-safe and derived from a seed. */
export function testDeviceId(seed: number): string {
  return newId(seededBytes(seed));
}
