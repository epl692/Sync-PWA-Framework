import {
  buildEnvelope,
  createMemoryStorage,
  createSyncCore,
  encodeEnvelope,
  formatClock,
  type Config,
  type OutboxEntry,
  type PacketBody,
  type PacketRecord,
  type StorageAdapter,
  type SyncCore,
} from '@sync/core';
import { createFakeClock, type FakeClock } from './helpers';
import { PlaintextCodec } from './plaintextCodec';

export interface TestCoreOptions extends Partial<Omit<Config, 'storage'>> {
  storage?: StorageAdapter;
  /** Register the plaintext test codec (default true). Pass false to test the no-codec case. */
  codec?: boolean;
  clock?: FakeClock;
}

export interface TestCore {
  core: SyncCore;
  storage: StorageAdapter;
  clock: FakeClock;
  /** Close and reopen a core on the same storage, as an app restart would. */
  reopen(): Promise<SyncCore>;
}

/** A core on in-memory storage with a fake clock and the plaintext codec. For tests only. */
export async function createTestCore(opts: TestCoreOptions = {}): Promise<TestCore> {
  const storage = opts.storage ?? createMemoryStorage();
  const clock = opts.clock ?? createFakeClock();
  const { codec: withCodec = true, storage: _s, clock: _c, ...rest } = opts;
  const open = () =>
    createSyncCore({
      now: clock.now,
      autoCompact: false, // tests compact explicitly
      ...rest,
      storage,
      codecs: withCodec ? [new PlaintextCodec()] : [],
    });
  const t: TestCore = {
    core: await open(),
    storage,
    clock,
    reopen: async () => {
      t.core = await open();
      return t.core;
    },
  };
  return t;
}

export interface RemoteOptions {
  author?: string;
  seq?: number;
  space?: string;
  wall?: number;
  counter?: number;
  codecId?: string;
}

/** Build a packet as a remote device would have authored it. */
export async function remoteEnvelope(
  body: Omit<PacketBody, 'schemaVersion'> & { schemaVersion?: number },
  o: RemoteOptions = {},
): Promise<{ env: ReturnType<typeof buildEnvelope>; raw: Uint8Array }> {
  const author = o.author ?? 'REMOTEAAAAAAAAAAAAAAAAAAA';
  const seq = o.seq ?? 1;
  const space = o.space ?? 's1';
  const codec = new PlaintextCodec();
  const bytes = await codec.encode({ schemaVersion: 1, ...body }, { space, author });
  const env = buildEnvelope({
    author,
    seq,
    space,
    clock: formatClock(o.wall ?? 1_700_000_000_000 + seq, o.counter ?? 0, author),
    codec: o.codecId ?? codec.id,
    body: bytes,
    sig: null,
  });
  return { env, raw: encodeEnvelope(env) };
}

export const flush = () => new Promise<void>((r) => setTimeout(r, 0));

export async function readOutbox(storage: StorageAdapter): Promise<OutboxEntry[]> {
  return storage.transaction(['outbox'], 'readonly', async (tx) => {
    const out: OutboxEntry[] = [];
    for await (const { value } of tx.scan<OutboxEntry>('outbox')) out.push(value);
    return out;
  });
}

export async function readPacketRecords(storage: StorageAdapter): Promise<PacketRecord[]> {
  return storage.transaction(['packets'], 'readonly', async (tx) => {
    const out: PacketRecord[] = [];
    for await (const { value } of tx.scan<PacketRecord>('packets')) out.push(value);
    return out;
  });
}
