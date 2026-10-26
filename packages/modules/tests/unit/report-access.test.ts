// T087: developers see each module's declared access and registrations without running it (US5-2).
import { describe, expect, it } from 'vitest';
import { createTestCore } from '@sync/testkit';
import { createHost } from '../../src/host/host';
import type { ModuleDefinition, ModuleReport } from '../../src/types';
import { simpleType } from '../helpers';

const quiet = { info() {}, warn() {}, error() {} };

describe('host.report()', () => {
  it('shows declared access and registrations before activation, after it, and for failed and skipped modules', async () => {
    const t = await createTestCore();
    const snapshots: ModuleReport[][] = [];
    const first: ModuleDefinition = { id: 'first', version: '1.0.0', activate: () => void snapshots.push(host.report()) };
    const second: ModuleDefinition = {
      id: 'second',
      version: '1.0.0',
      dependencies: { first: '^1.0.0' },
      access: { types: { read: ['first.thing'], write: ['other.data'] }, spaces: { read: 'any', write: 'bound', manage: true } },
      provides: { types: [simpleType('doc')], features: [{ id: 'f', start: () => undefined }], views: { box: () => class extends (globalThis.HTMLElement ?? (class {} as never)) {} } },
    };
    const broken: ModuleDefinition = { id: 'broken', version: '1.0.0', access: { types: { read: ['x.y'] } }, provides: { types: [simpleType('bad', { versions: [] })] } };
    const orphan: ModuleDefinition = { id: 'orphan', version: '1.0.0', dependencies: { ghost: '^1.0.0' }, access: { types: { write: ['second.doc'] } } };
    const host = createHost({ core: t.core, entries: [first, second, broken, orphan].map((def) => ({ def, source: 'bundled' as const })), defineViews: false, log: quiet });
    await host.start();

    // during first's activation, every module is already listed with what it declared
    const during = Object.fromEntries(snapshots[0]!.map((r) => [r.id, r]));
    expect(during.second).toMatchObject({ status: 'resolved' });
    expect(during.second!.access).toEqual({
      types: { read: ['first.thing', 'other.data', 'second.doc'], write: ['other.data', 'second.doc'] },
      spaces: { read: 'any', write: 'bound', manage: true },
    });
    expect(during.second!.registers).toEqual({ types: ['second.doc'], views: ['second-box'], features: ['second.f'], transports: [], identityProviders: [] });

    const after = Object.fromEntries(host.report().map((r) => [r.id, r]));
    expect(after.first!.status).toBe('active');
    expect(after.second!.status).toBe('active');
    expect(after.second!.access).toEqual(during.second!.access);
    expect(after.second!.dependencies).toEqual({ first: '^1.0.0' });

    expect(after.broken!.status).toBe('failed');
    expect(after.broken!.access.types.read).toEqual(['broken.bad', 'x.y']);
    expect(after.orphan!.status).toBe('skipped');
    expect(after.orphan!.access.types.write).toEqual(['second.doc']);
    expect(after.orphan!.reason).toMatch(/missing dependency "ghost"/);
  });

  it('is a snapshot: changing it does not change the host', async () => {
    const t = await createTestCore();
    const host = createHost({ core: t.core, entries: [{ def: { id: 'solo', version: '1.0.0' }, source: 'bundled' }], defineViews: false, log: quiet });
    await host.start();
    const r = host.report();
    r[0]!.access.types.read.push('evil.type');
    expect(host.report()[0]!.access.types.read).toEqual([]);
  });
});
