// Spec 005 T037 (US1, Constitution III): three clients and a Hub, with random writes and random disconnects and reconnects,
// always converge to the same state once everyone is connected.
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { MemoryBleLink, MockBleBridge, createSpaceAccess, createTestCore, memberProofs, waitFor } from '@sync/testkit';
import { createBluetoothTransport, createMemoryTrustStore } from '@sync/transport-bluetooth';
import { createHub, createMemoryStore } from '../../src';

const runs = Number(process.env.CONVERGENCE_RUNS ?? 12);

type Step = { kind: 'write'; c: number; v: number } | { kind: 'drop'; c: number } | { kind: 'join'; c: number };
const stepArb: fc.Arbitrary<Step> = fc.oneof(
  { weight: 5, arbitrary: fc.record({ kind: fc.constant('write' as const), c: fc.integer({ min: 0, max: 2 }), v: fc.integer({ min: 0, max: 9 }) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('drop' as const), c: fc.integer({ min: 0, max: 2 }) }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('join' as const), c: fc.integer({ min: 0, max: 2 }) }) },
);

describe('convergence through a Hub', () => {
  it('any interleaving of writes, drops and reconnects converges', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(stepArb, { minLength: 4, maxLength: 24 }), fc.constantFrom(23, 185), async (steps, mtu) => {
        const link = new MemoryBleLink({ mtu });
        const bridge = new MockBleBridge(link);
        const hub = await createHub({ bridge, store: createMemoryStore() });
        await hub.start();
        const access = await createSpaceAccess();
        await hub.addServeCode(access.serveCode);
        const cores: Array<Awaited<ReturnType<typeof createTestCore>>> = [];
        const transports: Array<ReturnType<typeof createBluetoothTransport>> = [];
        const online = [false, false, false];
        const owned: string[][] = [[], [], []];
        try {
          for (let i = 0; i < 3; i++) {
            const t = await createTestCore({ spaces: [access.space] });
            const transport = createBluetoothTransport({ proofs: await memberProofs([access], `c${i}`), confirmHub: async () => true, trustStore: createMemoryTrustStore(), bluetooth: link.bluetooth() as never, isSecureContext: true });
            t.core.addTransport(transport);
            cores.push(t);
            transports.push(transport);
          }
          const join = async (c: number) => {
            if (online[c]) return;
            await transports[c]!.chooseHub();
            online[c] = true;
          };
          const drop = async (c: number) => {
            if (!online[c]) return;
            const fp = transports[c]!.connections()[0]?.fingerprint;
            if (fp) await transports[c]!.disconnectHub(fp);
            online[c] = false;
            await new Promise((r) => setTimeout(r, 10));
          };
          for (const s of steps) {
            if (s.kind === 'join') await join(s.c);
            else if (s.kind === 'drop') await drop(s.c);
            else if (owned[s.c]!.length && s.v % 2 === 0) await cores[s.c]!.core.update(owned[s.c]![s.v % owned[s.c]!.length]!, { v: s.v, by: s.c });
            else owned[s.c]!.push((await cores[s.c]!.core.create(access.space, 'note', { v: s.v, by: s.c })).id);
          }
          for (let c = 0; c < 3; c++) await join(c);
          const total = owned.flat().length;
          await waitFor(async () => {
            const hashes = await Promise.all(cores.map((x) => x.core.stateHash(access.space)));
            return hashes.every((h) => h === hashes[0]) ? hashes[0] : '';
          }, 15_000, 'convergence');
          for (const x of cores) expect(await x.core.query({ space: access.space, type: 'note' }).once()).toHaveLength(total);
        } finally {
          for (const x of cores) await x.core.close().catch(() => undefined);
          await hub.stop().catch(() => undefined);
          await bridge.close();
        }
      }),
      { numRuns: runs, timeout: 60_000 },
    );
  }, 600_000);
});
