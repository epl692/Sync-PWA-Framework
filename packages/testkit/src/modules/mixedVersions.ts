/**
 * Peers running different versions of the same modules, exchanging packets in random order with duplicates
 * (SC-004 for spec 003). Each peer is a plaintext test core plus a module host.
 */

import type { SyncCore } from '@sync/core';
import { createHost, type DataFacade, type Host, type ModuleDefinition } from '@sync/modules';
import { createFakeClock, type FakeClock } from '../helpers';
import { createTestCore, readPacketRecords, type TestCore } from '../testCore';

export interface MixedPeerSpec {
  name: string;
  /** The modules this peer runs; give peers different versions of the same module id to mix versions. */
  modules: ModuleDefinition[];
  /** How far this device's clock is from true time. */
  skewMs?: number;
}

export interface MixedPeer {
  name: string;
  test: TestCore;
  core: SyncCore;
  host: Host;
  clock: FakeClock;
  /** The data facade of one of the peer's modules. */
  data(moduleId: string): DataFacade;
  /** Packets this peer refused (should stay empty when versions are compatible). */
  rejected: string[];
}

export interface MixedPeers {
  peers: Record<string, MixedPeer>;
  names: string[];
  /** Move every peer's clock forward. */
  advance(ms: number): void;
  /** Deliver everything the members hold to every member, in random order, with duplicates. */
  exchange(members: string[], rnd: () => number): Promise<void>;
  stateHashes(space: string): Promise<Record<string, string>>;
}

const BASE_TIME = 1_700_000_000_000;

export async function createMixedPeers(specs: readonly MixedPeerSpec[]): Promise<MixedPeers> {
  const peers: Record<string, MixedPeer> = {};
  for (const spec of specs) {
    const clock = createFakeClock(BASE_TIME + (spec.skewMs ?? 0));
    const test = await createTestCore({ clock });
    const host = createHost({
      core: test.core,
      entries: spec.modules.map((def) => ({ def, source: 'bundled' as const })),
      defineViews: false,
      log: { info() {}, warn() {}, error() {} },
    });
    await host.start();
    await host.closeBootWindow();
    const rejected: string[] = [];
    test.core.on((e) => {
      if (e.kind === 'packet:rejected') rejected.push(`${e.id}: ${e.reason}`);
    });
    peers[spec.name] = {
      name: spec.name,
      test,
      core: test.core,
      host,
      clock,
      rejected,
      data: (id) => {
        const ctx = host.contextOf(id);
        if (!ctx) throw new Error(`peer ${spec.name} has no active module "${id}"`);
        return ctx.data;
      },
    };
  }
  const names = specs.map((s) => s.name);

  const shuffled = <T>(items: T[], rnd: () => number): T[] => {
    const a = items.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [a[i], a[j]] = [a[j]!, a[i]!];
    }
    return a;
  };

  return {
    peers,
    names,
    advance: (ms) => names.forEach((n) => peers[n]!.clock.advance(ms)),
    async exchange(members, rnd) {
      const union = new Map<string, Uint8Array>();
      for (const n of members) for (const r of await readPacketRecords(peers[n]!.test.storage)) union.set(r.id, r.raw);
      for (const n of members) {
        let batch = shuffled([...union.values()], rnd);
        batch = shuffled(batch.concat(batch.filter(() => rnd() < 0.3)), rnd);
        for (let from = 0; from < batch.length; ) {
          const size = 1 + Math.floor(rnd() * 5);
          await peers[n]!.core.ingestBatch(batch.slice(from, from + size), 'mixed');
          from += size;
        }
      }
    },
    async stateHashes(space) {
      return Object.fromEntries(await Promise.all(names.map(async (n) => [n, await peers[n]!.core.stateHash(space)] as const)));
    },
  };
}
