import type { SyncCore } from '@sync/core';
import { MemoryNetwork } from './memoryTransport';
import { createTestCore, type TestCore, type TestCoreOptions } from './testCore';
import { createFakeClock } from './helpers';

export async function waitFor<T>(fn: () => T | Promise<T>, timeoutMs = 5000, label = 'condition'): Promise<Exclude<T, false | null | undefined | 0 | ''>> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as Exclude<T, false | null | undefined | 0 | ''>;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

export interface Peers {
  net: MemoryNetwork;
  peers: Record<string, TestCore>;
  core(name: string): SyncCore;
  /** Link two peers over a transport id and attach the transport to both cores (once). */
  link(a: string, b: string, transportId?: string): void;
  /** Resolve once every listed peer reports the same state hash for the Space. */
  converged(space: string, names?: string[], timeoutMs?: number): Promise<string>;
}

/** Several test cores on one in-memory network. Pass `spaces` so empty devices still join a Space. */
export async function createPeers(names: string[], opts: TestCoreOptions = {}, net = new MemoryNetwork()): Promise<Peers> {
  const clock = createFakeClock();
  const peers: Record<string, TestCore> = {};
  for (const n of names) peers[n] = await createTestCore({ ...opts, clock });
  const attached = new Set<string>();
  const api: Peers = {
    net,
    peers,
    core: (n) => peers[n]!.core,
    link(a, b, tid = 'memory') {
      for (const n of [a, b]) {
        const k = `${tid}/${n}`;
        if (!attached.has(k)) {
          attached.add(k);
          peers[n]!.core.addTransport(net.transport(n, tid));
        }
      }
      net.link(a, b, tid);
    },
    async converged(space, list = names, timeoutMs = 8000) {
      return waitFor<string>(
        async () => {
          const hashes = await Promise.all(list.map((n) => peers[n]!.core.stateHash(space)));
          return hashes.every((h) => h === hashes[0]) ? hashes[0]! : '';
        },
        timeoutMs,
        `peers ${list.join(',')} to converge on ${space}`,
      );
    },
  };
  return api;
}
