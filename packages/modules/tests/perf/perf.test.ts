// T109: performance budgets from plan.md. The plan's targets assume a mid-range phone, about 4x slower than CI.
// Numbers are printed so they can be compared with the targets; the assertions are scaled and tolerant of shared runners.
import { describe, expect, it } from 'vitest';
import { createTestCore, remoteEnvelope } from '@sync/testkit';
import { createHost } from '../../src/host/host';
import { SchemaRegistry } from '../../src/schema/registry';
import { createSchemaValidator } from '../../src/validator/schema-validator';
import type { ModuleDefinition } from '../../src/types';

const SLOWDOWN = 4;
const quiet = { info() {}, warn() {}, error() {} };

const field = { type: 'string' as const, maxLength: 100 };
const manyModules = (modules: number, typesEach: number): ModuleDefinition[] =>
  Array.from({ length: modules }, (_, m) => ({
    id: `mod${m}`,
    version: '1.0.0',
    dependencies: m > 0 ? { [`mod${m - 1}`]: '^1.0.0' } : undefined,
    provides: {
      types: Array.from({ length: typesEach }, (_, t) => ({
        name: `type${t}`,
        versions: [{ version: 1, fields: { title: field, note: field, done: { type: 'boolean' as const, default: false }, n: { type: 'integer' as const } } }],
      })),
    },
  }));

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

describe('registration', () => {
  it('registers 50 modules with 200 types in under 100 ms on the phone profile', async () => {
    const defs = manyModules(50, 4);
    const runs: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t = await createTestCore();
      const host = createHost({ core: t.core, entries: defs.map((def) => ({ def, source: 'bundled' as const })), defineViews: false, log: quiet });
      const start = performance.now();
      await host.start();
      runs.push(performance.now() - start);
      expect(host.report().filter((r) => r.status === 'active')).toHaveLength(50);
      expect(host.registry.list()).toHaveLength(200);
    }
    const took = median(runs);
    console.log(`registering 50 modules / 200 types: ${took.toFixed(1)} ms here, about ${(took * SLOWDOWN).toFixed(0)} ms on the phone profile (target < 100 ms)`);
    expect(took * SLOWDOWN).toBeLessThan(100);
  });
});

describe('validation', () => {
  it('adds under 5% to the ingest of 10,000 packets (asserted with margin for noisy runners)', async () => {
    const N = 10_000;
    const raws: Uint8Array[] = [];
    for (let i = 0; i < N; i++) {
      const p = await remoteEnvelope({ obj: `o${i % 500}`, op: i < 500 ? 'create' : 'update', type: 'mod0.type0', fields: { title: `title ${i}`, note: 'a note about it', n: i } }, { author: `DEVICE${i % 20}`, seq: Math.floor(i / 20) + 1, wall: 1_700_000_000_000 + i });
      raws.push(p.raw);
    }
    const ingest = async (withValidator: boolean) => {
      const t = await createTestCore();
      if (withValidator) {
        const registry = new SchemaRegistry();
        registry.register('mod0', { name: 'type0', versions: [{ version: 1, fields: { title: field, note: field, done: { type: 'boolean', default: false }, n: { type: 'integer' } } }] });
        const v = createSchemaValidator(registry);
        v.closeBootWindow();
        t.core.registerValidator(v);
      }
      const start = performance.now();
      for (let i = 0; i < raws.length; i += 500) await t.core.ingestBatch(raws.slice(i, i + 500), 'perf');
      return performance.now() - start;
    };
    await ingest(false); // warm up
    const plain: number[] = [];
    const checked: number[] = [];
    for (let i = 0; i < 3; i++) {
      plain.push(await ingest(false));
      checked.push(await ingest(true));
    }
    const ratio = median(checked) / median(plain);
    console.log(`ingest of ${N} packets: ${median(plain).toFixed(0)} ms plain, ${median(checked).toFixed(0)} ms with schema validation (+${((ratio - 1) * 100).toFixed(1)}%, target < 5%)`);
    expect(ratio).toBeLessThan(1.2);
  }, 120_000);
});
