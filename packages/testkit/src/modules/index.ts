/** Module contract suite and a fake module host (Principle VIII, spec 003). */

import { describe, expect, it } from 'vitest';
import type { JSONValue, SyncCore } from '@sync/core';
import {
  checkSchema,
  createFacade,
  createHost,
  validateDefinition,
  type Host,
  type HostOptions,
  type ModuleDefinition,
} from '@sync/modules';
import { createTestCore, type TestCore } from '../testCore';

export interface FakeModuleHost {
  host: Host;
  core: SyncCore;
  test: TestCore;
}

/** A module host on a plaintext test core. Views are not defined as elements, so one module can be hosted many times. */
export async function fakeModuleHost(defs: readonly ModuleDefinition[], opts: Partial<HostOptions> = {}): Promise<FakeModuleHost> {
  const test = await createTestCore();
  const host = createHost({
    core: test.core,
    entries: defs.map((def) => ({ def, source: 'bundled' as const })),
    defineViews: false,
    log: { info() {}, warn() {}, error() {} },
    ...opts,
  });
  await host.start();
  return { host, core: test.core, test };
}

export interface ModuleContractOptions {
  name: string;
  definition: ModuleDefinition;
  /** Modules the definition depends on (hosted alongside it). */
  dependencies?: readonly ModuleDefinition[];
  /** Valid example field sets per full type name; each must be accepted and read back unchanged. */
  fixtures?: Record<string, Array<Record<string, JSONValue>>>;
}

/**
 * Run against any ModuleDefinition to prove it follows the Module contract: definition and schema rules,
 * clean activation and deactivation, valid fixtures round-trip, and a crashing sibling does not affect it.
 */
export function moduleContract(opts: ModuleContractOptions): void {
  const { definition: def } = opts;
  const deps = opts.dependencies ?? [];

  describe(`module contract: ${opts.name}`, () => {
    it('has a valid definition', () => {
      expect(validateDefinition(def)).toEqual([]);
    });

    it('declares only schemas that pass the lint', () => {
      for (const t of def.provides?.types ?? []) expect(checkSchema(t), t.name).toEqual([]);
    });

    it('activates cleanly and stops cleanly', async () => {
      const { host } = await fakeModuleHost([...deps, def]);
      const r = host.report().find((x) => x.id === def.id)!;
      expect(r.reason).toBeUndefined();
      expect(r.status).toBe('active');
      await host.stop();
      expect(host.report().find((x) => x.id === def.id)!.status).toBe('stopped');
    });

    it('registers exactly the types it declares', async () => {
      const { host } = await fakeModuleHost([...deps, def]);
      const declared = (def.provides?.types ?? []).map((t) => `${def.id}.${t.name}`).sort();
      expect(host.registry.list().filter((t) => t.module === def.id).map((t) => t.type).sort()).toEqual(declared);
    });

    for (const [type, examples] of Object.entries(opts.fixtures ?? {})) {
      it(`accepts and reads back its fixtures for ${type}`, async () => {
        const { host, core } = await fakeModuleHost([...deps, def]);
        const facade = createFacade({ core, registry: host.registry, moduleId: def.id, emit: () => {} });
        for (const fields of examples) {
          const o = await facade.create('s1', type, fields);
          expect(o.violations).toBeUndefined();
          expect(o.fields).toMatchObject(fields);
        }
      });
    }

    it('keeps working when a sibling module crashes', async () => {
      const crasher: ModuleDefinition = {
        id: 'crasher',
        version: '1.0.0',
        activate: () => {
          throw new Error('crash');
        },
      };
      const { host } = await fakeModuleHost([...deps, crasher, def]);
      expect(host.report().find((x) => x.id === 'crasher')!.status).toBe('failed');
      expect(host.report().find((x) => x.id === def.id)!.status).toBe('active');
    });
  });
}
