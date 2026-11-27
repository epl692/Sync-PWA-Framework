// Spec 005 T074 and T076 (US3): an interrupted sync resumes by sending only what is missing; a client that was away catches up.
import { afterEach, describe, expect, it } from 'vitest';
import { b64urlDecode, decodeEnvelope, decodeMessage } from '@sync/core';
import { MemoryBleLink, MockBleBridge, createSpaceAccess, createTestCore, memberProofs, waitFor } from '@sync/testkit';
import { createBluetoothTransport, createMemoryTrustStore } from '@sync/transport-bluetooth';
import { createHub, createMemoryStore } from '../../src';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!().catch(() => undefined);
});

async function world() {
  const link = new MemoryBleLink({ mtu: 185 });
  const bridge = new MockBleBridge(link);
  const hub = await createHub({ bridge, store: createMemoryStore(), relay: { batchPackets: 20 } });
  await hub.start();
  const access = await createSpaceAccess();
  await hub.addServeCode(access.serveCode);
  cleanups.push(async () => void (await hub.stop(), await bridge.close()));
  const client = async (name: string, air?: Parameters<MemoryBleLink['bluetooth']>[0]) => {
    const t = await createTestCore({ spaces: [access.space] });
    const transport = createBluetoothTransport({ proofs: await memberProofs([access], name), confirmHub: async () => true, trustStore: createMemoryTrustStore(), bluetooth: link.bluetooth(air) as never, isSecureContext: true });
    t.core.addTransport(transport);
    cleanups.push(async () => void (await transport.stop(), await t.core.close()));
    return { core: t.core, transport };
  };
  return { link, bridge, hub, access, client };
}

/** Every packet id that arrives at a transport, in order, across sessions. */
function trackDeliveries(transport: ReturnType<typeof createBluetoothTransport>) {
  const ids: string[] = [];
  transport.on('message', (_p, bytes) => {
    if (bytes[0] !== 0x7b) return;
    const d = decodeMessage(bytes) as { ok: boolean; msg?: { t: string; items?: string[] } };
    if (d.ok && d.msg?.t === 'packets') for (const item of d.msg.items ?? []) ids.push(decodeEnvelope(b64urlDecode(item)).env.id);
  });
  return ids;
}

describe('resume after an interruption', () => {
  it('re-sends nothing that was already delivered, and the end state matches an uninterrupted sync (SC-003)', async () => {
    const w = await world();
    const a = await w.client('alice');
    await a.transport.chooseHub();
    const N = 300;
    for (let i = 0; i < N; i++) await a.core.create(w.access.space, 'note', { i, pad: 'p'.repeat(100) });
    await waitFor(() => w.hub.relay.stats.packets === N, 20_000, 'the Hub to hold everything');

    const b = await w.client('bob', { latencyMs: 4 }); // a slow link, so there is a midway to interrupt
    const delivered = trackDeliveries(b.transport);
    await b.transport.chooseHub();
    await waitFor(() => delivered.length >= 40, 10_000, 'the sync to get going');
    w.bridge.setInRange(false); // interrupt it midway
    await waitFor(() => b.transport.connections().length === 0, 3000, 'drop');
    const before = delivered.length;
    expect(before).toBeLessThan(N);
    w.bridge.setInRange(true);
    await b.transport.chooseHub();
    await waitFor(async () => (await b.core.query({ space: w.access.space, type: 'note' }).once()).length === N, 20_000, 'the rest to arrive');
    const received = new Set(delivered.slice(0, before));
    const afterwards = delivered.slice(before);
    // nothing B already held was sent again (in-flight packets that never arrived are fine to resend)
    expect(afterwards.filter((id) => received.has(id))).toEqual([]);
    expect(await b.core.stateHash(w.access.space)).toBe(await a.core.stateHash(w.access.space));
  }, 90_000);

  it('a client that was away while others edited receives everything the Hub kept for it', async () => {
    const w = await world();
    const a = await w.client('alice');
    const b = await w.client('bob');
    await a.transport.chooseHub();
    await b.transport.chooseHub();
    await a.core.create(w.access.space, 'note', { n: 0 });
    await waitFor(async () => (await b.core.query({ space: w.access.space, type: 'note' }).once()).length === 1, 5000, 'first note');
    await b.transport.disconnectHub(b.transport.connections()[0]!.fingerprint);
    for (let i = 1; i <= 25; i++) await a.core.create(w.access.space, 'note', { n: i });
    await waitFor(() => w.hub.relay.stats.packets === 26, 10_000, 'the Hub to hold them all');
    await b.transport.chooseHub();
    await waitFor(async () => (await b.core.query({ space: w.access.space, type: 'note' }).once()).length === 26, 10_000, 'bob to catch up');
    expect(await b.core.stateHash(w.access.space)).toBe(await a.core.stateHash(w.access.space));
  }, 60_000);
});

describe('link state shown to the user', () => {
  it('goes idle after a quiet spell, back to syncing on traffic, and counts what is queued to send', async () => {
    const w = await world();
    const a = await w.client('alice');
    const states: string[] = [];
    a.transport.onConnections((c) => c[0] && states.push(c[0].state));
    await a.transport.chooseHub();
    await waitFor(() => a.transport.connections()[0]?.state === 'idle', 6000, 'idle after a quiet spell');
    expect(a.transport.connections()[0]!.pendingOut).toBe(0);
    await a.core.create(w.access.space, 'note', { x: 1 });
    await waitFor(() => a.transport.connections()[0]?.state === 'syncing', 2000, 'syncing on traffic');
    expect(states).toContain('idle');
  }, 30_000);
});
