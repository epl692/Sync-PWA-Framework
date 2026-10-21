/** Secure test nodes: a real core with the encrypting codec, signer and validators, on in-memory storage. */

import { createMemoryStorage, type StorageAdapter, type SyncCore } from '@sync/core';
import { memoryKeyDb, openSecureCore, type IdentityProvider, type KeyDb, type Spaces } from '@sync/spaces';
import { MemoryNetwork } from '../memoryTransport';
import { createFakeClock, type FakeClock } from '../helpers';
import { createStubIdentityProvider } from './stubIdentityProvider';

export interface SecureNodeOptions {
  name?: string;
  clock?: FakeClock;
  provider?: () => IdentityProvider;
  approveJoin?: (req: import('@sync/spaces').JoinRequestView) => boolean | Promise<boolean>;
  approveLink?: (device: import('@sync/spaces').DevicePublic, sas: string) => boolean | Promise<boolean>;
  rotationGraceMs?: number;
  storage?: StorageAdapter;
  keyDb?: KeyDb;
  signUp?: boolean | string;
  coreConfig?: Record<string, unknown>;
}

export interface SecureNode {
  name: string;
  core: SyncCore;
  spaces: Spaces;
  storage: StorageAdapter;
  keyDb: KeyDb;
  clock: FakeClock;
  /** Close and reopen on the same storage and key database, as an app restart would. */
  reopen(before?: () => Promise<void>): Promise<SecureNode>;
}

export async function createSecureNode(opts: SecureNodeOptions = {}): Promise<SecureNode> {
  const clock = opts.clock ?? createFakeClock();
  const storage = opts.storage ?? createMemoryStorage();
  const keyDb = opts.keyDb ?? memoryKeyDb();
  const open = async (): Promise<SecureNode> => {
    const { core, spaces } = await openSecureCore({
      keyDb,
      provider: (opts.provider ?? createStubIdentityProvider)(),
      now: clock.now,
      approveJoin: opts.approveJoin ?? (() => true),
      approveLink: opts.approveLink,
      rotationGraceMs: opts.rotationGraceMs ?? 20,
      core: { storage, now: clock.now, autoCompact: false, ...(opts.coreConfig ?? {}) },
    });
    const node: SecureNode = {
      name: opts.name ?? 'node',
      core,
      spaces,
      storage,
      keyDb,
      clock,
      reopen: async (before) => {
        await spaces.close();
        await core.close();
        await before?.();
        return open();
      },
    };
    return node;
  };
  const node = await open();
  if (opts.signUp !== false) await node.spaces.signUp(typeof opts.signUp === 'string' ? opts.signUp : (opts.name ?? 'node'));
  return node;
}

export interface SecureGroup {
  net: MemoryNetwork;
  nodes: Record<string, SecureNode>;
  clock: FakeClock;
  node(name: string): SecureNode;
  link(a: string, b: string, transportId?: string): void;
  close(): Promise<void>;
}

/** Several secure nodes on one in-memory network and one fake clock. */
export async function createSecureGroup(names: string[], opts: SecureNodeOptions = {}): Promise<SecureGroup> {
  const clock = opts.clock ?? createFakeClock();
  const net = new MemoryNetwork();
  const nodes: Record<string, SecureNode> = {};
  for (const n of names) nodes[n] = await createSecureNode({ ...opts, name: n, clock });
  const attached = new Set<string>();
  return {
    net,
    nodes,
    clock,
    node: (n) => nodes[n]!,
    link(a, b, tid = 'memory') {
      for (const n of [a, b]) {
        const k = `${tid}/${n}`;
        if (!attached.has(k)) {
          attached.add(k);
          nodes[n]!.core.addTransport(net.transport(n, tid));
        }
      }
      net.link(a, b, tid);
    },
    async close() {
      for (const n of Object.values(nodes)) {
        await n.spaces.close();
        await n.core.close();
      }
    },
  };
}
