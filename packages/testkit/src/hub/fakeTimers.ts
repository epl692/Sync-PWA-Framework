/** Manually advanced timers and clock for Hub tests: nothing fires until `advance()`. */

export interface FakeTimers {
  now(): number;
  advance(ms: number): Promise<void>;
  timers: {
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(h: unknown): void;
    setInterval(fn: () => void, ms: number): unknown;
    clearInterval(h: unknown): void;
  };
}

export function createFakeTimers(start = 1_800_000_000_000): FakeTimers {
  let t = start;
  let next = 1;
  const q = new Map<number, { at: number; fn: () => void; every?: number }>();
  return {
    now: () => t,
    async advance(ms) {
      const end = t + ms;
      const fired = new Map<number, number>();
      for (;;) {
        const due = [...q.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [id, v] = due;
        t = Math.max(t, v.at);
        if (v.every) {
          // a very long advance would fire a short interval millions of times: after 200 firings spread the rest out
          const n = (fired.get(id) ?? 0) + 1;
          fired.set(id, n);
          v.at += n > 200 ? Math.max(v.every, Math.ceil((end - t) / 50)) : v.every;
        } else q.delete(id);
        v.fn();
        // let promise continuations run between timers
        await new Promise((r) => setTimeout(r, 0));
      }
      t = end;
      await new Promise((r) => setTimeout(r, 0));
    },
    timers: {
      setTimeout(fn, ms) {
        const id = next++;
        q.set(id, { at: t + ms, fn });
        return id;
      },
      clearTimeout(h) {
        q.delete(h as number);
      },
      setInterval(fn, ms) {
        const id = next++;
        q.set(id, { at: t + ms, fn, every: ms });
        return id;
      },
      clearInterval(h) {
        q.delete(h as number);
      },
    },
  };
}
