// T099 (US6, SC-004): peers on version 1 and version 2 of a schema, editing the same objects, always converge and lose nothing.
import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { UNSET } from '@sync/core';
import { createMixedPeers, seededRandom } from '@sync/testkit';
import { appV1, appV2, appV2NoDown } from './schema';

const RUNS = Number(process.env.MIXED_RUNS ?? process.env.CONVERGENCE_RUNS ?? 1000);
const SPACE = 's1';

type Kind = 'create' | 'title' | 'name' | 'done' | 'priority' | 'remove';
interface Op {
  peer: number;
  kind: Kind;
  obj: number;
  n: number;
}
interface Epoch {
  groups: number[][];
  ops: Op[];
}
interface Run {
  versions: Array<'v1' | 'v2'>;
  skew: number[];
  epochs: Epoch[];
  seed: number;
}

const partitions = (n: number): fc.Arbitrary<number[][]> =>
  fc.array(fc.integer({ min: 0, max: 2 }), { minLength: n, maxLength: n }).map((assign) => {
    const g = new Map<number, number[]>();
    assign.forEach((x, i) => g.set(x, [...(g.get(x) ?? []), i]));
    return [...g.values()];
  });

const runArb: fc.Arbitrary<Run> = fc
  .record({ v1: fc.integer({ min: 1, max: 2 }), v2: fc.integer({ min: 1, max: 2 }) })
  .chain(({ v1, v2 }) => {
    const versions: Array<'v1' | 'v2'> = [...Array(v1).fill('v1'), ...Array(v2).fill('v2')];
    const n = versions.length;
    return fc.record({
      versions: fc.shuffledSubarray(versions, { minLength: n, maxLength: n }),
      skew: fc.array(fc.oneof(fc.constant(0), fc.integer({ min: -60_000, max: 60_000 }), fc.integer({ min: -7_200_000, max: 7_200_000 })), { minLength: n, maxLength: n }),
      epochs: fc.array(
        fc.record({
          groups: partitions(n),
          ops: fc.array(
            fc.record({
              peer: fc.integer({ min: 0, max: n - 1 }),
              kind: fc.constantFrom<Kind>('create', 'create', 'title', 'name', 'done', 'priority', 'remove'),
              obj: fc.integer({ min: 0, max: 2 }),
              n: fc.integer({ min: 0, max: 9 }),
            }),
            { minLength: 1, maxLength: 8 },
          ),
        }),
        { minLength: 1, maxLength: 3 },
      ),
      seed: fc.integer(),
    });
  });

async function play(run: Run, v2Module: typeof appV2) {
  const mixed = await createMixedPeers(run.versions.map((v, i) => ({ name: `p${i}`, modules: [v === 'v1' ? appV1 : v2Module], skewMs: run.skew[i] })));
  const rnd = seededRandom(run.seed);
  const written = new Map<number, Set<string>>(); // names ever written per object
  const removed = new Set<number>();
  const note = (obj: number, ...names: string[]) => written.set(obj, new Set([...(written.get(obj) ?? []), ...names]));

  for (const epoch of run.epochs) {
    for (const op of epoch.ops) {
      mixed.advance(1 + Math.floor(rnd() * 400));
      const peer = mixed.peers[`p${op.peer}`]!;
      const isV2 = run.versions[op.peer] === 'v2';
      const data = peer.data('app');
      const id = `o${op.obj}`;
      const exists = !!(await data.get(id));
      try {
        if (op.kind === 'create') {
          if (exists) continue;
          if (isV2) {
            await data.create(SPACE, 'app.item', { name: `v2-${op.n}`, priority: op.n }, { id });
            note(op.obj, 'name', 'done', 'priority', ...(v2Module === appV2 ? ['title'] : []));
          } else {
            await data.create(SPACE, 'app.item', { title: `v1-${op.n}` }, { id });
            note(op.obj, 'title', 'done');
          }
        } else if (!exists) {
          continue;
        } else if (op.kind === 'remove') {
          await data.remove(id);
          removed.add(op.obj);
        } else if (op.kind === 'title' && !isV2) {
          await data.update(id, { title: `v1-${op.n}` });
          note(op.obj, 'title');
        } else if (op.kind === 'name' && isV2) {
          await data.update(id, { name: `v2-${op.n}` });
          note(op.obj, 'name', ...(v2Module === appV2 ? ['title'] : []));
        } else if (op.kind === 'done') {
          await data.update(id, { done: op.n % 2 === 0 });
          note(op.obj, 'done');
        } else if (op.kind === 'priority' && isV2) {
          await data.update(id, { priority: op.n });
          note(op.obj, 'priority');
        }
      } catch (e) {
        if (!(e instanceof Error) || !/not found|may not write/.test(e.message)) throw e;
      }
    }
    for (const g of epoch.groups) await mixed.exchange(g.map((i) => `p${i}`), rnd);
  }
  await mixed.exchange(mixed.names, rnd);
  await mixed.exchange(mixed.names, rnd);
  return { mixed, written, removed };
}

describe('mixed v1/v2 peers converge (SC-004)', () => {
  it(`with a down mirror: ${RUNS} randomized runs`, async () => {
    await fc.assert(
      fc.asyncProperty(runArb, async (run) => {
        const { mixed, written, removed } = await play(run, appV2);

        // a. one state everywhere, and no valid write was refused because of a version difference
        const hashes = Object.values(await mixed.stateHashes(SPACE));
        expect(new Set(hashes).size).toBe(1);
        for (const n of mixed.names) expect(mixed.peers[n]!.rejected, n).toEqual([]);

        const idOf = (o: number) => `o${o}`;
        for (const [o, names] of written) {
          if (removed.has(o)) continue;
          // b. every peer still stores every field anyone wrote, v1 peers included (what they cannot show, they keep)
          for (const n of mixed.names) {
            const raw = await mixed.peers[n]!.core.get(idOf(o));
            expect(raw, `${n} has ${idOf(o)}`).toBeDefined();
            for (const f of names) expect(Object.keys(raw!.fields), `${n}.${idOf(o)} keeps ${f}`).toContain(f);
          }
          // c. peers on the same version show the same thing
          for (const v of ['v1', 'v2'] as const) {
            const group = mixed.names.filter((_, i) => run.versions[i] === v);
            const views = await Promise.all(group.map(async (n) => (await mixed.peers[n]!.data('app').get(idOf(o)))?.fields));
            for (const view of views) expect(view).toEqual(views[0]);
          }
          // d. with the mirror, what a v1 peer calls title is what a v2 peer calls name
          const first = (v: 'v1' | 'v2') => mixed.names.find((_, i) => run.versions[i] === v)!;
          const t = (await mixed.peers[first('v1')]!.data('app').get(idOf(o)))?.fields.title;
          const nm = (await mixed.peers[first('v2')]!.data('app').get(idOf(o)))?.fields.name;
          expect(nm, `${idOf(o)} name vs title`).toBe(t);
        }
      }),
      { numRuns: RUNS },
    );
  }, 600_000);

  it('without a down: still converges, v1 peers keep every v2 field, they just do not see renamed fields change', async () => {
    await fc.assert(
      fc.asyncProperty(runArb, async (run) => {
        const { mixed, written, removed } = await play(run, appV2NoDown);
        expect(new Set(Object.values(await mixed.stateHashes(SPACE))).size).toBe(1);
        for (const n of mixed.names) expect(mixed.peers[n]!.rejected, n).toEqual([]);
        for (const [o, names] of written) {
          if (removed.has(o)) continue;
          for (const n of mixed.names) {
            const raw = await mixed.peers[n]!.core.get(`o${o}`);
            for (const f of names) expect(Object.keys(raw!.fields), `${n}.o${o} keeps ${f}`).toContain(f);
          }
        }
      }),
      { numRuns: Math.max(100, Math.floor(RUNS / 5)) },
    );
  }, 600_000);

  it('UNSET is just another field write across versions', async () => {
    const mixed = await createMixedPeers([
      { name: 'a', modules: [appV1] },
      { name: 'b', modules: [appV2] },
    ]);
    const rnd = seededRandom(1);
    await mixed.peers.a!.data('app').create(SPACE, 'app.item', { title: 'x' }, { id: 'o1' });
    await mixed.exchange(['a', 'b'], rnd);
    mixed.advance(10);
    await mixed.peers.b!.data('app').update('o1', { name: UNSET });
    await mixed.exchange(['a', 'b'], rnd);
    expect((await mixed.peers.b!.data('app').get('o1'))!.fields.name).toBeUndefined();
    expect((await mixed.peers.a!.data('app').get('o1'))!.fields.title).toBeUndefined(); // the mirror removed it for v1 as well
    expect(Object.values(await mixed.stateHashes(SPACE)).every((h, _, all) => h === all[0])).toBe(true);
  });
});
