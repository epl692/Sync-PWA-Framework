// T008 (A-3): snapshots can be sealed and signed; bad or unreadable ones are discarded.
import { describe, expect, it } from 'vitest';
import { canonicalBytes, parseJsonBytes, type CoreEvent, type SnapshotGuard } from '@sync/core';
import { createPeers, waitFor } from '@sync/testkit';

const DAY = 24 * 60 * 60 * 1000;
const sha256 = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource));
const xor = (b: Uint8Array) => b.map((x) => x ^ 0x5a);

function guard(opts: { accept?: boolean } = {}): SnapshotGuard {
  return {
    async seal(_space, objects) {
      return xor(canonicalBytes({ objects } as never));
    },
    async open(_space, bytes) {
      try {
        return { ok: true, objects: (parseJsonBytes(xor(bytes)) as { objects: unknown[] }).objects };
      } catch {
        return { ok: false, reason: 'malformed' };
      }
    },
    async sign(_space, canonical) {
      return { signer: 'SIGNERAAAAAAAAAAAAAAAAAAAA', sig: await sha256(canonical) };
    },
    async verify(_space, signer, canonical, sig) {
      if (opts.accept === false) return { accept: false, reason: 'bad signature' };
      const ok = signer === 'SIGNERAAAAAAAAAAAAAAAAAAAA' && !!sig && (await sha256(canonical)).every((b, i) => b === sig[i]);
      return ok ? { accept: true } : { accept: false, reason: 'bad signature' };
    },
  };
}

async function compactedPeer(names: string[]) {
  const p = await createPeers(names, { spaces: ['s1'], retentionWindowMs: 30 * DAY });
  const ids: string[] = [];
  for (let i = 0; i < 4; i++) ids.push((await p.core('a').create('s1', 'item', { marker: 'SECRET-MARKER', i })).id);
  p.peers.a!.clock.advance(40 * DAY);
  expect((await p.core('a').compact()).packetsRemoved).toBeGreaterThan(0);
  return p;
}

describe('A-3 sealed and signed snapshots', () => {
  it('sends sealed objects (no plaintext marker on the wire) and the receiver converges', async () => {
    const p = await compactedPeer(['a', 'b']);
    p.core('a').registerSnapshotGuard(guard());
    p.core('b').registerSnapshotGuard(guard());
    const wire: string[] = [];
    p.net.tap((_f, _t, bytes) => wire.push(new TextDecoder().decode(bytes)));
    p.link('a', 'b');
    await p.converged('s1');
    const snapshots = wire.filter((m) => m.includes('"t":"snapshot"'));
    expect(snapshots.length).toBeGreaterThan(0);
    expect(wire.join('\n')).not.toContain('SECRET-MARKER');
    expect(snapshots[0]).toContain('"sealed"');
    expect(snapshots[0]).toContain('"sig"');
  });

  it('discards a snapshot whose signature does not verify, and reports it', async () => {
    const p = await compactedPeer(['a', 'b']);
    p.core('a').registerSnapshotGuard(guard());
    p.core('b').registerSnapshotGuard(guard({ accept: false }));
    const events: CoreEvent[] = [];
    p.core('b').on((e) => events.push(e));
    p.link('a', 'b');
    await waitFor(() => events.some((e) => e.kind === 'packet:rejected' && /snapshot/.test(e.reason)), 3000, 'snapshot rejection');
    expect((await p.core('b').query({ type: 'item' }).once()).length).toBe(0);
  });

  it('discards a sealed snapshot when the receiver has no guard', async () => {
    const p = await compactedPeer(['a', 'b']);
    p.core('a').registerSnapshotGuard(guard());
    const events: CoreEvent[] = [];
    p.core('b').on((e) => events.push(e));
    p.link('a', 'b');
    await waitFor(() => events.some((e) => e.kind === 'packet:rejected' && /snapshot/.test(e.reason)), 3000, 'snapshot rejection');
    expect((await p.core('b').query({ type: 'item' }).once()).length).toBe(0);
  });

  it('discards an unsealed snapshot when the receiver requires a guard', async () => {
    const p = await compactedPeer(['a', 'b']);
    p.core('b').registerSnapshotGuard(guard());
    const events: CoreEvent[] = [];
    p.core('b').on((e) => events.push(e));
    p.link('a', 'b');
    await waitFor(() => events.some((e) => e.kind === 'packet:rejected' && /snapshot/.test(e.reason)), 3000, 'snapshot rejection');
    expect((await p.core('b').query({ type: 'item' }).once()).length).toBe(0);
  });
});
