/**
 * Lane contract (spec 004, Principle VIII): a Transport must carry the binary lane (messages whose first byte is a lane
 * magic, 0x80..0xFF) exactly like any other message: intact, at any size the core will accept, without disturbing the
 * JSON sync messages around it and without reporting it as an error. `transportContract()` runs this suite for every
 * transport, so an implementation that passes the transport contract is lane-ready.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { PeerId } from '@sync/core';
import type { TransportHarness } from '../transportContract';

const LANE_MAGIC = 0xb1;

function until<T>(fn: () => T | undefined | false, timeoutMs = 5000, label = 'condition'): Promise<T> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const v = fn();
      if (v) return resolve(v as T);
      if (Date.now() - start > timeoutMs) return reject(new Error(`timed out waiting for ${label}`));
      setTimeout(tick, 5);
    };
    tick();
  });
}

const laneMessage = (size: number, seed = 31): Uint8Array => {
  const b = new Uint8Array(size);
  for (let i = 1; i < size; i++) b[i] = (i * seed + 7) & 0xff;
  b[0] = LANE_MAGIC;
  return b;
};
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
const json = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));

/** Core default for `limits.maxMessageBytes`: lane messages up to this size must arrive, framed by the transport if needed. */
const CORE_LIMIT = 4 * 1024 * 1024;

export function laneContract(name: string, harness: TransportHarness) {
  describe(`Lane contract: ${name}`, () => {
    const cleanups: (() => Promise<void>)[] = [];
    afterEach(async () => {
      while (cleanups.length) await cleanups.pop()!().catch(() => undefined);
    });

    async function started() {
      const h = await harness.create();
      cleanups.push(h.teardown);
      let peer: PeerId | undefined;
      const received: Uint8Array[] = [];
      const errors: string[] = [];
      h.transport.on('peerConnected', (p) => void (peer = p.id));
      h.transport.on('message', (_p, b) => received.push(b));
      h.transport.on('error', (e) => errors.push(`${e.code}: ${e.message}`));
      const fromTransport: Uint8Array[] = [];
      h.remote.onMessage((b) => fromTransport.push(b));
      await h.transport.start();
      await harness.afterStart?.(h.transport);
      await until(() => peer, 5000, 'peerConnected');
      return { ...h, peer: () => peer!, received, fromTransport, errors };
    }

    it('round-trips a large lane message intact in both directions', async () => {
      const t = await started();
      const size = Math.min(harness.largeMessageBytes ?? 1024 * 1024, t.transport.capabilities.maxMessageBytes);
      const msg = laneMessage(size);
      await t.transport.send(t.peer(), msg);
      await until(() => t.fromTransport.length >= 1, 15000, 'lane message to remote');
      expect(same(t.fromTransport[0]!, msg)).toBe(true);
      await t.remote.send(msg);
      await until(() => t.received.length >= 1, 15000, 'lane message back');
      expect(same(t.received[0]!, msg)).toBe(true);
      expect(t.errors).toEqual([]);
    });

    it('keeps JSON messages around lane messages intact (order is not required)', async () => {
      const t = await started();
      const hello = json({ t: 'ping' });
      const lane = laneMessage(64 * 1024, 17);
      const sent = [hello, lane, hello, lane, hello];
      for (const m of sent) await t.transport.send(t.peer(), m);
      await until(() => t.fromTransport.length >= sent.length, 10000, 'five messages');
      const lanes = t.fromTransport.filter((b) => b[0] === LANE_MAGIC);
      const jsons = t.fromTransport.filter((b) => b[0] === 0x7b);
      expect(lanes).toHaveLength(2);
      expect(jsons).toHaveLength(3);
      expect(lanes.every((b) => same(b, lane))).toBe(true);
      expect(jsons.every((b) => same(b, hello))).toBe(true);
      expect(t.errors).toEqual([]);
    });

    it('carries many lane messages without loss while sync-sized JSON messages keep flowing', async () => {
      const t = await started();
      const n = 40;
      for (let i = 0; i < n; i++) {
        const m = laneMessage(2048, i + 1);
        m[1] = i;
        await t.transport.send(t.peer(), m);
        if (i % 8 === 0) await t.transport.send(t.peer(), json({ t: 'pong', i }));
      }
      await until(() => t.fromTransport.filter((b) => b[0] === LANE_MAGIC).length >= n, 15000, 'all lane messages');
      const seen = new Set(t.fromTransport.filter((b) => b[0] === LANE_MAGIC).map((b) => b[1]));
      expect(seen.size).toBe(n);
    });

    it('carries a lane message of the transport maxMessageBytes, and larger ones up to the core limit (framed by the transport)', async () => {
      const t = await started();
      const max = t.transport.capabilities.maxMessageBytes;
      // exactly the unframed limit, capped so a 64 MiB in-memory limit does not make the test slow
      const exact = Math.min(max, harness.largeMessageBytes ?? 256 * 1024);
      const a = laneMessage(exact, 5);
      await t.transport.send(t.peer(), a);
      await until(() => t.fromTransport.some((b) => b.length === exact), 15000, 'message at the limit');
      expect(same(t.fromTransport.find((b) => b.length === exact)!, a)).toBe(true);
      // above the unframed limit but within the core limit: only meaningful for transports with a small limit
      if (max < CORE_LIMIT / 2) {
        const over = laneMessage(Math.min(CORE_LIMIT / 2, max * 4 + 1), 9);
        await t.transport.send(t.peer(), over);
        await until(() => t.fromTransport.some((b) => b.length === over.length), 30000, 'message above the unframed limit');
        expect(same(t.fromTransport.find((b) => b.length === over.length)!, over)).toBe(true);
      }
      expect(t.errors).toEqual([]);
    });
  });
}
