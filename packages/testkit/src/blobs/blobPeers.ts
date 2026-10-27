/**
 * Blob test harness: N secure devices (real core, encrypting codec, signer, validators) in one Space on an in-memory
 * network, with lane fault injection. Blob engines are created by the test (the harness does not depend on the engine).
 */
import { createSecureGroup, type SecureGroup, type SecureNode, type SecureNodeOptions } from '../spaces/secureNode';
import { waitFor } from '../peers';
import { LaneFaults } from './tamper';

export interface BlobPeersOptions extends SecureNodeOptions {
  /** `mesh`: every device linked to every other (default). `star`: everyone linked to the first device only. */
  topology?: 'mesh' | 'star';
  /** Fault injection seed. */
  seed?: number;
  /** Role of the devices other than the first (the Owner). Default editor. */
  role?: 'editor' | 'viewer';
  /** Devices that are linked to the others but never invited to the Space (they hold no keys and declare no Spaces). */
  outsiders?: string[];
}

export interface BlobPeers {
  g: SecureGroup;
  /** Space ID created by the first device. */
  space: string;
  faults: LaneFaults;
  node(name: string): SecureNode;
  /** Let background work (grants, rotations, joins) settle. */
  settle(rounds?: number): Promise<void>;
  close(): Promise<void>;
}

export async function createBlobPeers(names: string[], opts: BlobPeersOptions = {}): Promise<BlobPeers> {
  const g = await createSecureGroup(names, { rotationGraceMs: 20, ...opts });
  const faults = new LaneFaults(opts.seed ?? 1);
  for (const n of names) faults.install(g.net.transport(n, 'memory'));
  const [owner, ...others] = names as [string, ...string[]];
  const outsiders = new Set(opts.outsiders ?? []);
  const rest = others.filter((n) => !outsiders.has(n));
  const links = opts.topology === 'star' ? others.map((n) => [owner, n] as const) : names.flatMap((a, i) => names.slice(i + 1).map((b) => [a, b] as const));
  for (const [a, b] of links) g.link(a, b);

  const space = await g.node(owner).spaces.create('Blobs');
  for (const n of rest) {
    const art = await g.node(owner).spaces.invite(space.id, { role: opts.role ?? 'editor', expiresAt: g.clock.now() + 3_600_000, maxUses: 1, approval: 'auto' });
    await g.node(n).spaces.accept(art.url);
  }
  for (const n of rest) await waitFor(async () => (await g.node(n).spaces.list()).length === 1, 10_000, `${n} sees the Space`);

  const settle = async (rounds = 3) => {
    for (let i = 0; i < rounds; i++) {
      for (const n of Object.values(g.nodes)) await n.spaces.idle();
      await new Promise((r) => setTimeout(r, 30));
    }
  };
  await settle();
  return { g, space: space.id, faults, node: (n) => g.node(n), settle, close: () => g.close() };
}
