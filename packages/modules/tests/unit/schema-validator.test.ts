// T049: the PacketValidator's verdicts (contracts/schema-rules.md, verdict mapping).
import { describe, expect, it } from 'vitest';
import type { DataPacketEnvelope, PacketBody } from '@sync/core';
import { createSchemaValidator } from '../../src/validator/schema-validator';
import { SchemaRegistry } from '../../src/schema/registry';

const registry = new SchemaRegistry();
registry.register('m', { name: 'item', versions: [{ version: 1, fields: { title: { type: 'string', required: true, maxLength: 5 } } }] });
const env = {} as DataPacketEnvelope;
const ctx = { now: () => 0 };
const body = (over: Partial<PacketBody>): PacketBody => ({ obj: 'o1', op: 'create', type: 'm.item', schemaVersion: 1, fields: { title: 'ok' }, ...over });

describe('SchemaValidator', () => {
  it('runs in both phases', () => {
    expect(createSchemaValidator(registry).phases).toEqual(['send', 'apply']);
  });

  it('accepts a valid body in both phases', async () => {
    const v = createSchemaValidator(registry);
    for (const phase of ['send', 'apply'] as const) expect(await v.validate(phase, env, body({}), ctx)).toEqual({ verdict: 'accept' });
  });

  it('rejects an invalid body in both phases, with the type and field in the reason', async () => {
    const v = createSchemaValidator(registry);
    for (const phase of ['send', 'apply'] as const) {
      const r = await v.validate(phase, env, body({ fields: { title: 'toolong' } }), ctx);
      expect(r).toMatchObject({ verdict: 'reject' });
      expect((r as { reason: string }).reason).toMatch(/m\.item\.title/);
    }
  });

  it('accepts $-prefixed system types without looking at them', async () => {
    const v = createSchemaValidator(registry);
    expect(await v.validate('apply', env, body({ type: '$sys.member', fields: { whatever: 1 } }), ctx)).toEqual({ verdict: 'accept' });
  });

  it('accepts a packet it cannot decode yet (no body)', async () => {
    expect(await createSchemaValidator(registry).validate('apply', env, undefined, ctx)).toEqual({ verdict: 'accept' });
  });

  it('defers an unknown type on apply while the boot window is open, then accepts it as opaque', async () => {
    const v = createSchemaValidator(registry);
    const unknown = body({ type: 'later.thing', fields: { x: 1 } });
    expect(await v.validate('apply', env, unknown, ctx)).toMatchObject({ verdict: 'defer', reason: 'unknown-type' });
    v.closeBootWindow();
    expect(await v.validate('apply', env, unknown, ctx)).toEqual({ verdict: 'accept' });
  });

  it('never defers on send', async () => {
    const v = createSchemaValidator(registry);
    expect(await v.validate('send', env, body({ type: 'later.thing' }), ctx)).toEqual({ verdict: 'accept' });
  });

  it('follows registrations made after it was created', async () => {
    const r = new SchemaRegistry();
    const v = createSchemaValidator(r);
    v.closeBootWindow();
    expect(await v.validate('apply', env, body({ fields: { title: 'toolong' } }), ctx)).toEqual({ verdict: 'accept' }); // opaque
    r.register('m', { name: 'item', versions: [{ version: 1, fields: { title: { type: 'string', maxLength: 5 } } }] });
    expect(await v.validate('apply', env, body({ fields: { title: 'toolong' } }), ctx)).toMatchObject({ verdict: 'reject' });
  });
});
