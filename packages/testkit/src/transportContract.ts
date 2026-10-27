import { afterEach, describe, expect, it } from 'vitest';
import type { PeerId, Transport } from '@sync/core';
import { laneContract } from './blobs/laneContract';

/** The far end of a transport under test, seen at the byte level. */
export interface RemoteEnd {
  /** Send bytes to the transport under test. */
  send(bytes: Uint8Array): Promise<void> | void;
  /** Messages the transport under test sent to us. */
  onMessage(cb: (bytes: Uint8Array) => void): void;
  /** Drop the connection abruptly. */
  disconnect(): Promise<void> | void;
  /** Optional: re-establish after disconnect (for transports that reconnect by themselves). */
  reconnect?(): Promise<void> | void;
  /** Optional: put raw junk on the wire that is not a valid frame/message for this transport. */
  injectCorrupt?(): Promise<void> | void;
}

export interface TransportHarness {
  /** Create a transport plus its far end. The transport is not started yet. */
  create(): Promise<{ transport: Transport; remote: RemoteEnd; teardown(): Promise<void> }>;
  /** Optional: a transport whose environment cannot run it (supported() is false). */
  createUnsupported?(): Transport;
  /** Optional: runs right after transport.start(), for transports that need a manual step (e.g. WebRTC pairing). */
  afterStart?(transport: Transport): Promise<void>;
  /** True if the transport reconnects on its own after the remote drops. */
  reconnects?: boolean;
  /** Largest message to try (default 1 MiB, capped by capabilities). */
  largeMessageBytes?: number;
}

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

const bytesOf = (...n: number[]) => Uint8Array.from(n);
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Reusable Transport contract suite (Principle VIII, SC-005). Any implementation that passes works
 * in any app with no core changes:
 *   transportContract('my transport', harness)
 */
export function transportContract(name: string, harness: TransportHarness) {
  describe(`Transport contract: ${name}`, () => {
    const cleanups: (() => Promise<void>)[] = [];
    afterEach(async () => {
      while (cleanups.length) await cleanups.pop()!().catch(() => undefined);
    });

    async function started() {
      const h = await harness.create();
      cleanups.push(h.teardown);
      const events: string[] = [];
      let peer: PeerId | undefined;
      const received: Uint8Array[] = [];
      h.transport.on('peerConnected', (p) => {
        peer = p.id;
        events.push('connected');
      });
      h.transport.on('peerDisconnected', () => events.push('disconnected'));
      h.transport.on('message', (_p, b) => received.push(b));
      const fromTransport: Uint8Array[] = [];
      h.remote.onMessage((b) => fromTransport.push(b));
      await h.transport.start();
      await harness.afterStart?.(h.transport);
      await until(() => peer, 5000, 'peerConnected');
      return { ...h, events, peer: () => peer!, received, fromTransport };
    }

    it('declares sane capabilities and a stable id', () => {
      return harness.create().then(async (h) => {
        cleanups.push(h.teardown);
        expect(h.transport.id).toMatch(/^[a-z0-9-]+$/);
        expect(h.transport.capabilities.maxMessageBytes).toBeGreaterThan(0);
        expect(typeof h.transport.capabilities.ordered).toBe('boolean');
        expect(h.transport.supported()).toEqual({ ok: true });
        expect(h.transport.state).toBe('idle');
      });
    });

    it('connects, reports ready, and announces the peer', async () => {
      const t = await started();
      expect(t.transport.state).toBe('ready');
      expect(t.events).toContain('connected');
    });

    it('delivers bytes unchanged in both directions', async () => {
      const t = await started();
      const payload = bytesOf(0, 255, 1, 254, 0, 0, 127, 128);
      await t.transport.send(t.peer(), payload);
      await until(() => t.fromTransport.length >= 1, 5000, 'delivery to remote');
      expect(same(t.fromTransport[0]!, payload)).toBe(true);

      await t.remote.send(payload);
      await until(() => t.received.length >= 1, 5000, 'delivery to transport');
      expect(same(t.received[0]!, payload)).toBe(true);
    });

    it('delivers many messages without loss (order is not required)', async () => {
      const t = await started();
      const n = 50;
      for (let i = 0; i < n; i++) await t.transport.send(t.peer(), bytesOf(i, i + 1));
      await until(() => t.fromTransport.length >= n, 8000, 'all messages');
      const seen = new Set(t.fromTransport.map((b) => b[0]));
      expect(seen.size).toBe(n);
      if (t.transport.capabilities.ordered) {
        expect(t.fromTransport.map((b) => b[0])).toEqual(Array.from({ length: n }, (_, i) => i));
      }
    });

    it('carries a large message intact', async () => {
      const t = await started();
      const size = Math.min(harness.largeMessageBytes ?? 1024 * 1024, t.transport.capabilities.maxMessageBytes);
      const big = new Uint8Array(size).map((_, i) => (i * 31 + 7) & 0xff);
      await t.transport.send(t.peer(), big);
      await until(() => t.fromTransport.length >= 1, 15000, 'large message');
      expect(same(t.fromTransport[0]!, big)).toBe(true);
      await t.remote.send(big);
      await until(() => t.received.length >= 1, 15000, 'large message back');
      expect(same(t.received[0]!, big)).toBe(true);
    });

    it('reports an abrupt remote close and rejects sends to the gone peer', async () => {
      const t = await started();
      await t.remote.disconnect();
      await until(() => t.events.includes('disconnected'), 5000, 'peerDisconnected');
      if (!harness.reconnects) {
        await expect(t.transport.send(t.peer(), bytesOf(1))).rejects.toBeDefined();
      }
    });

    if (harness.reconnects) {
      it('reconnects by itself and carries messages again', async () => {
        const t = await started();
        await t.remote.disconnect();
        await until(() => t.events.includes('disconnected'), 5000, 'peerDisconnected');
        await t.remote.reconnect?.();
        await until(() => t.events.filter((e) => e === 'connected').length >= 2, 15000, 'second peerConnected');
        await t.transport.send(t.peer(), bytesOf(9, 9));
        await until(() => t.fromTransport.some((b) => b[0] === 9), 5000, 'message after reconnect');
      });
    }

    it('stops cleanly and returns to idle', async () => {
      const t = await started();
      await t.transport.stop();
      expect(t.transport.state).toBe('idle');
    });

    if (harness.createUnsupported) {
      it('reports unsupported environments without throwing', async () => {
        const u = harness.createUnsupported!();
        const r = u.supported();
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason.length).toBeGreaterThan(0);
        await expect(u.start()).resolves.toBeUndefined();
        expect(u.state).toBe('unsupported');
        await expect(u.send('x', bytesOf(1))).rejects.toBeDefined();
        await u.stop();
      });
    }

    it('isolates a corrupt message: later valid messages still arrive', async () => {
      const t = await started();
      if (!t.remote.injectCorrupt) return; // not applicable to transports with no framing
      await t.remote.injectCorrupt();
      await t.remote.send(bytesOf(4, 2));
      await until(() => t.received.some((b) => b[0] === 4 && b[1] === 2), 5000, 'valid message after corrupt one');
    });
  });

  // Spec 004: every transport must also carry the binary lane.
  laneContract(name, harness);
}
