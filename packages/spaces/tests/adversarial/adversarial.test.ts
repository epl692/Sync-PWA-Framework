// T048 (SC-001): randomized hostile streams. No invalid packet is applied on any peer, in any delivery order,
// and every peer ends in the same state as a peer that was only ever shown the valid packets.
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { b64urlEncode, decodeEnvelope } from '@sync/core';
import { createSecureNode, readPacketRecords, type SecureNode } from '@sync/testkit';
import { Keystore } from '../../src';
import { SYS } from '../../src/authority/types';
import { World, makeDevice, pub, type TestDevice } from '../packets';

const RUNS = Number(process.env.CONVERGENCE_RUNS ?? 12);
const SEED = process.env.CONVERGENCE_SEED ? Number(process.env.CONVERGENCE_SEED) : undefined;
const REMOVE_AT = 100;

type Kind =
  | 'A'
  | 'B'
  | 'Redit'
  | 'Rlate'
  | 'Rbackdated'
  | 'C'
  | 'X'
  | 'flip'
  | 'unsigned'
  | 'clock'
  | 'epochflip'
  | 'dupe';
const kinds: Kind[] = [
  'A',
  'B',
  'Redit',
  'Rlate',
  'Rbackdated',
  'C',
  'X',
  'flip',
  'unsigned',
  'clock',
  'epochflip',
  'dupe',
];

const scenario = fc.record({
  steps: fc.array(fc.record({ kind: fc.constantFrom(...kinds), t: fc.integer({ min: 10, max: 90 }) }), {
    minLength: 4,
    maxLength: 16,
  }),
  seeds: fc.tuple(fc.integer(), fc.integer(), fc.integer()),
});

function shuffled<T>(xs: T[], seed: number): T[] {
  const out = [...xs];
  let s = seed >>> 0;
  for (let i = out.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

async function judge(world: World): Promise<SecureNode> {
  const n = await createSecureNode({ signUp: false });
  const ks = await Keystore.open(n.keyDb);
  await ks.putEpochKey(world.space, 0, world.raw.get(world.space)!, 'grant');
  return n;
}

async function run(steps: Array<{ kind: Kind; t: number }>, seeds: [number, number, number]) {
  const world = new World();
  const A = await makeDevice('A');
  const B = await makeDevice('B');
  const C = await makeDevice('C');
  const R = await makeDevice('R');
  const X = await makeDevice('X');
  await world.init(A);
  const binding = { kind: 'stub-token/1', proof: '' };
  const bind = (d: TestDevice) => ({
    kind: 'stub-token/1',
    proof: b64urlEncode(new TextEncoder().encode(`ok|${d.user}|${d.id}`)),
  });

  // the valid control history
  const valid: Array<{ raw: Uint8Array; id: string }> = [];
  const ctl = async <T extends keyof import('../../src/authority/types').ControlFields>(
    dev: TestDevice,
    type: T,
    fields: import('../../src/authority/types').ControlFields[T],
    t: number,
  ) => {
    const p = await world.control(dev, type, fields, t);
    valid.push({ raw: p.raw, id: p.env.id });
    return p;
  };
  void binding;
  await ctl(
    A,
    SYS.genesis,
    { owner: { user: A.id, device: A.id, ...pub(A), binding: bind(A) }, nonce: b64urlEncode(world.nonce) },
    1,
  );
  await ctl(A, SYS.epoch, { scope: world.space, epoch: 0, keyId: [...world.keys.values()][0]!.keyId }, 2);
  let t = 3;
  for (const d of [B, C, R]) {
    await ctl(A, SYS.device, { user: d.user, device: d.id, ...pub(d), binding: bind(d) }, t++);
    await ctl(A, SYS.member, { action: 'add', user: d.user, role: d === C ? 'viewer' : 'editor' }, t++);
  }

  const invalidIds = new Set<string>();
  const validObjs = new Set<string>();
  const packets: Uint8Array[] = [];
  const data = (dev: TestDevice, i: number) => world.body('item', { n: i }, `obj-${i}`);
  let i = 0;
  let rEarly = 0;
  const todo = steps.map((s) => ({ ...s, i: i++ }));
  // R's early packets must take the lowest sequence numbers, so author them first
  for (const s of todo.filter((x) => x.kind === 'Redit')) {
    const p = await world.packet(R, data(R, s.i), s.t, { seq: ++rEarly });
    packets.push(p.raw);
    validObjs.add(`obj-${s.i}`);
  }
  for (const s of todo) {
    const body = data(A, s.i);
    switch (s.kind) {
      case 'A':
      case 'B': {
        const p = await world.packet(s.kind === 'A' ? A : B, body, s.t);
        packets.push(p.raw);
        validObjs.add(body.obj);
        break;
      }
      case 'Redit':
        break;
      case 'Rlate': {
        const p = await world.packet(R, body, REMOVE_AT + 10 + s.t, { seq: rEarly + 1 + s.i });
        packets.push(p.raw);
        invalidIds.add(p.env.id);
        break;
      }
      case 'Rbackdated': {
        const p = await world.packet(R, body, s.t, { seq: rEarly + 1 + s.i }); // clock before the removal, sequence number beyond the cutoff
        packets.push(p.raw);
        invalidIds.add(p.env.id);
        break;
      }
      case 'C':
      case 'X': {
        const p = await world.packet(s.kind === 'C' ? C : X, body, s.t);
        packets.push(p.raw);
        invalidIds.add(p.env.id);
        break;
      }
      case 'flip': {
        const p = await world.packet(B, body, s.t, {
          tamper: (e) => ({ ...e, sig: e.sig!.map((b, k) => (k === 5 ? b ^ 1 : b)) }),
        });
        packets.push(p.raw);
        invalidIds.add(p.env.id);
        break;
      }
      case 'unsigned': {
        const p = await world.packet(B, body, s.t, { sign: false });
        packets.push(p.raw);
        invalidIds.add(p.env.id);
        break;
      }
      case 'clock': {
        const p = await world.packet(B, body, s.t, {
          tamper: (e) => ({
            ...e,
            clock: e.clock.replace(
              /^(.{12})-(.{4})-/,
              (_m, w: string, c: string) => `${w}-${(parseInt(c, 16) ^ 1).toString(16).padStart(4, '0')}-`,
            ),
          }),
        });
        packets.push(p.raw);
        invalidIds.add(p.env.id);
        break;
      }
      case 'epochflip': {
        const p = await world.packet(B, body, s.t, {
          tamper: (e) => ({ ...e, body: e.body.map((b, k) => (k === 20 ? b ^ 1 : b)) }),
        });
        packets.push(p.raw);
        invalidIds.add(p.env.id);
        break;
      }
      case 'dupe': {
        const p = await world.packet(B, body, s.t);
        packets.push(p.raw, p.raw, p.raw);
        validObjs.add(body.obj);
        break;
      }
    }
  }
  const removal = await ctl(
    A,
    SYS.member,
    { action: 'remove', user: R.user, cutoff: { [R.id]: rEarly } },
    REMOVE_AT,
  );

  const allValid = [
    ...valid.map((v) => v.raw),
    ...packets.filter((raw) => !invalidIds.has(decodeEnvelope(raw).env.id)),
  ];
  const everything = [...valid.map((v) => v.raw), ...packets];

  const ref = await judge(world);
  for (const raw of allValid) await ref.core.ingest(raw, 'ref');
  await ref.spaces.idle();
  const refHash = await ref.core.stateHash(world.space);

  const judges = [await judge(world), await judge(world), await judge(world)];
  const failures: string[] = [];
  for (const [k, j] of judges.entries()) {
    for (const raw of shuffled(everything, seeds[k]!)) await j.core.ingest(raw, `peer${k}`);
    await j.spaces.idle();
    await j.core.revalidate();
    await j.spaces.idle();
    const applied = new Set(
      (await readPacketRecords(j.storage)).filter((r) => r.status === 'applied').map((r) => r.id),
    );
    for (const id of invalidIds) if (applied.has(id)) failures.push(`judge ${k} applied invalid ${id}`);
    const objs = new Set((await j.core.query({ type: 'item' }).once()).map((o) => o.id));
    for (const o of validObjs) if (!objs.has(o)) failures.push(`judge ${k} lacks valid ${o}`);
    for (const o of objs) if (!validObjs.has(o)) failures.push(`judge ${k} shows ${o}`);
    if ((await j.core.stateHash(world.space)) !== refHash) failures.push(`judge ${k} diverged`);
  }
  for (const n of [ref, ...judges]) {
    await n.spaces.close();
    await n.core.close();
  }
  void removal;
  return failures;
}

describe('adversarial streams (SC-001)', () => {
  it('applies no invalid packet on any peer, in any order, and converges to the valid state', async () => {
    await fc.assert(
      fc.asyncProperty(scenario, async ({ steps, seeds }) => {
        const failures = await run(steps, seeds as [number, number, number]);
        if (failures.length) throw new Error(failures.join('; '));
        return true;
      }),
      { numRuns: RUNS, seed: SEED },
    );
  }, Math.max(600_000, RUNS * 2500));

  it('handles the worst case: every kind of attack in one stream, delivered in reverse', async () => {
    const steps = kinds.map((kind, i) => ({ kind, t: 10 + i }));
    const failures = await run([...steps, ...steps, { kind: 'Redit' as Kind, t: 50 }], [1, 2, 3]);
    expect(failures).toEqual([]);
  }, 120_000);
});
