// Spec 005 T102 (research R-17): how much has to cross the air to sync a 1,000-object Space, and what that means at real Bluetooth
// speeds. The simulator has no bandwidth limit, so the time is computed from the bytes: bytes / rate. Results are printed and recorded
// in specs/005-bluetooth-transport/validation.md.
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryBleLink, MockBleBridge, createSpaceAccess, createTestCore, memberProofs, waitFor } from '@sync/testkit';
import { createBluetoothTransport, createMemoryTrustStore } from '@sync/transport-bluetooth';
import { createHub, createMemoryStore } from '../../src';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await Promise.race([cleanups.pop()!().catch(() => undefined), new Promise((r) => setTimeout(r, 3000))]);
});

describe('first sync of a 1,000-object Space', () => {
  it('moves about a megabyte, which takes well under 2 minutes at 20 KB/s and under 30 s at 100 KB/s', async () => {
    const link = new MemoryBleLink({ mtu: 185 });
    const bridge = new MockBleBridge(link);
    const hub = await createHub({ bridge, store: createMemoryStore() });
    await hub.start();
    const access = await createSpaceAccess();
    await hub.addServeCode(access.serveCode);
    cleanups.push(async () => void (await hub.stop(), await bridge.close()));
    const make = async (name: string) => {
      const t = await createTestCore({ spaces: [access.space] });
      const transport = createBluetoothTransport({ proofs: await memberProofs([access], name), confirmHub: async () => true, trustStore: createMemoryTrustStore(), bluetooth: link.bluetooth() as never, isSecureContext: true });
      t.core.addTransport(transport);
      cleanups.push(async () => void (await transport.stop(), await t.core.close()));
      return { core: t.core, transport };
    };
    const a = await make('alice');
    await a.transport.chooseHub();
    for (let i = 0; i < 1000; i++) await a.core.create(access.space, 'note', { title: `Note ${i}`, body: 'The quick brown fox jumps over the lazy dog. '.repeat(3), n: i, tags: ['a', 'b'] });
    await waitFor(() => hub.relay.stats.packets === 1000, 60_000, 'the Hub to hold 1,000 packets');
    await a.transport.disconnectHub(a.transport.connections()[0]!.fingerprint);
    await new Promise((r) => setTimeout(r, 100));

    const before = { ...link.stats };
    const b = await make('bob');
    const started = Date.now();
    await b.transport.chooseHub();
    await waitFor(async () => (await b.core.query({ space: access.space, type: 'note' }).once()).length === 1000, 60_000, 'bob to receive 1,000 notes');
    const cpuMs = Date.now() - started;
    const down = link.stats.bytesToCentral - before.bytesToCentral;
    const up = link.stats.bytesToPeripheral - before.bytesToPeripheral;
    const total = down + up;
    const at = (rate: number) => Math.round(down / rate);
    // eslint-disable-next-line no-console
    console.log(`1000 objects: ${down} bytes down, ${up} bytes up, ${link.stats.framesToCentral - before.framesToCentral} frames down; at 20 KB/s ${at(20_000)} s, at 100 KB/s ${at(100_000)} s; CPU wall ${cpuMs} ms`);
    expect(total).toBeGreaterThan(100_000);
    expect(at(20_000)).toBeLessThan(120); // under 2 minutes at 20 KB/s (research R-17)
    expect(at(100_000)).toBeLessThan(30); // under 30 s at 100 KB/s
    // the link's own overhead (frame headers, acks, control) on top of the sync data stays small
    const payload = (await hub.storage()).usedBytes;
    expect(down).toBeLessThan(payload * 1.6);
  }, 120_000);
});
