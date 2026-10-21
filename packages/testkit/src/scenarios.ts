/**
 * Random partition scenarios for convergence tests (SC-004): several devices with skewed clocks make
 * random edits during partitions; packets are then delivered in random order with duplicates.
 */
import fc from 'fast-check';
import { UNSET, type SyncCore } from '@sync/core';
import { createFakeClock, seededRandom } from './helpers';
import { createTestCore, readPacketRecords, type TestCore } from './testCore';

export interface ScenarioOp {
  device: number;
  kind: 'create' | 'update' | 'remove' | 'unset';
  obj: number;
  field: string;
  value: number;
}

export interface Scenario {
  devices: number;
  /** Per-device clock offset from true time, in ms (up to hours). */
  skewMs: number[];
  epochs: { groups: number[][]; ops: ScenarioOp[] }[];
  shuffleSeed: number;
}

const partitionArb = (devices: number): fc.Arbitrary<number[][]> =>
  fc.array(fc.integer({ min: 0, max: 2 }), { minLength: devices, maxLength: devices }).map((assign) => {
    const groups = new Map<number, number[]>();
    assign.forEach((g, d) => groups.set(g, [...(groups.get(g) ?? []), d]));
    return [...groups.values()];
  });

const opArb = (devices: number): fc.Arbitrary<ScenarioOp> =>
  fc.record({
    device: fc.integer({ min: 0, max: devices - 1 }),
    kind: fc.constantFrom('create', 'update', 'update', 'update', 'remove', 'unset') as fc.Arbitrary<ScenarioOp['kind']>,
    obj: fc.integer({ min: 0, max: 3 }),
    field: fc.constantFrom('a', 'b', 'c'),
    value: fc.integer({ min: 0, max: 9 }),
  });

const skewArb = fc.oneof(
  { weight: 2, arbitrary: fc.constant(0) },
  { weight: 3, arbitrary: fc.integer({ min: -60_000, max: 60_000 }) },
  { weight: 3, arbitrary: fc.integer({ min: -7_200_000, max: 7_200_000 }) },
  { weight: 1, arbitrary: fc.constantFrom(-86_400_000, 86_400_000, 3 * 365 * 86_400_000) },
);

export const scenarioArb: fc.Arbitrary<Scenario> = fc.integer({ min: 2, max: 4 }).chain((devices) =>
  fc.record({
    devices: fc.constant(devices),
    skewMs: fc.array(skewArb, { minLength: devices, maxLength: devices }),
    epochs: fc.array(
      fc.record({ groups: partitionArb(devices), ops: fc.array(opArb(devices), { minLength: 1, maxLength: 8 }) }),
      { minLength: 1, maxLength: 3 },
    ),
    shuffleSeed: fc.integer(),
  }),
);

const BASE_TIME = 1_700_000_000_000;
const SPACE = 's1';

function shuffled<T>(items: T[], rnd: () => number): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

async function allRaw(t: TestCore): Promise<Map<string, Uint8Array>> {
  const m = new Map<string, Uint8Array>();
  for (const r of await readPacketRecords(t.storage)) m.set(r.id, r.raw);
  return m;
}

/** Deliver everything the group holds to every member, in random order, with some duplicates. */
async function exchange(cores: TestCore[], members: number[], rnd: () => number): Promise<void> {
  const union = new Map<string, Uint8Array>();
  for (const i of members) for (const [id, raw] of await allRaw(cores[i]!)) union.set(id, raw);
  for (const i of members) {
    let batch = shuffled([...union.values()], rnd);
    batch = batch.concat(batch.filter(() => rnd() < 0.3)); // duplicates
    batch = shuffled(batch, rnd);
    for (let from = 0; from < batch.length; ) {
      const size = 1 + Math.floor(rnd() * 5);
      await cores[i]!.core.ingestBatch(batch.slice(from, from + size), 'scenario');
      from += size;
    }
  }
}

export interface ScenarioResult {
  /** The devices, when `keepCores` was requested. */
  cores?: TestCore[];
  hashes: string[];
  /** Hashes after delivering every packet to everyone a second time (must not change). */
  rehashed: string[];
}

export async function runScenario(
  sc: Scenario,
  config: { resurrectingTypes?: string[] } = {},
  options: { keepCores?: boolean } = {},
): Promise<ScenarioResult> {
  const rnd = seededRandom(sc.shuffleSeed);
  const clocks = sc.skewMs.map((s) => createFakeClock(BASE_TIME + s));
  const cores: TestCore[] = [];
  for (let i = 0; i < sc.devices; i++) cores.push(await createTestCore({ clock: clocks[i], ...config }));

  let t = 0;
  const apply = async (op: ScenarioOp) => {
    t += 1 + Math.floor(rnd() * 400);
    clocks.forEach((c, i) => c.set(BASE_TIME + t + sc.skewMs[i]!));
    const core: SyncCore = cores[op.device]!.core;
    const id = `o${op.obj}`;
    const visible = !!(await core.get(id));
    try {
      if (op.kind === 'create') await core.create(SPACE, 'thing', { [op.field]: op.value }, { id });
      else if (!visible) return;
      else if (op.kind === 'update') await core.update(id, { [op.field]: op.value });
      else if (op.kind === 'unset') await core.update(id, { [op.field]: UNSET });
      else await core.remove(id);
    } catch (e) {
      if ((e as { code?: string }).code !== 'not-found') throw e;
    }
  };

  for (const epoch of sc.epochs) {
    for (const op of epoch.ops) await apply(op);
    for (const group of epoch.groups) await exchange(cores, group, rnd);
  }
  const everyone = cores.map((_, i) => i);
  await exchange(cores, everyone, rnd);
  const hashes = await Promise.all(cores.map((c) => c.core.stateHash(SPACE)));
  await exchange(cores, everyone, rnd);
  const rehashed = await Promise.all(cores.map((c) => c.core.stateHash(SPACE)));
  return { hashes, rehashed, cores: options.keepCores ? cores : undefined };
}
