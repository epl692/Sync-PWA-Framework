/** The module host: resolve, activate (transactionally), report (research R-05). */

import type { JSONValue, SpaceId, SyncCore } from '@sync/core';
import type { Spaces } from '@sync/spaces';
import { createFacade } from '../access/facade';
import { checkSchema } from '../schema/lint';
import { SchemaRegistry } from '../schema/registry';
import { FeatureRunner, type FeatureHandle, type LocksLike } from '../features/runner';
import { wrapElement } from '../ui/wrap-element';
import type { ModuleContext, ModuleDefinition, ModuleHost, ModuleReport, SpacesFacade } from '../types';
import { consoleLogger, makeContext, type Logger } from './context';
import { HostState, newReport } from './report';
import { resolveModules, type Known, type ResolveEntry } from './resolve';

export interface HostOptions {
  core: SyncCore;
  spaces?: Spaces;
  entries: readonly ResolveEntry[];
  settings?: Record<string, Record<string, JSONValue>>;
  /** Transports to create, as `<moduleId>.<id>`. Others declared by modules are ignored. */
  transports?: readonly string[];
  /** Per-module activation timeout. Default 5000. */
  activateTimeoutMs?: number;
  log?: Logger;
  /** Define the modules' views as custom elements. Default true; contract suites turn it off so a module can be hosted many times. */
  defineViews?: boolean;
  /** Web Locks for singleton features. Default `navigator.locks`; null forces "unavailable". */
  locks?: LocksLike | null;
}

export interface Host extends ModuleHost {
  /** Resolve and activate every entry. Resolves when all have settled. */
  start(): Promise<void>;
  readonly registry: SchemaRegistry;
}

interface Committed {
  def: ModuleDefinition;
  features: FeatureHandle[];
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms)));
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

const defaultLocks = (): LocksLike | null => ((globalThis as { navigator?: { locks?: LocksLike } }).navigator?.locks ?? null);

export function createHost(o: HostOptions): Host {
  const { core } = o;
  const state = new HostState();
  const registry = new SchemaRegistry();
  const log = o.log ?? consoleLogger;
  const timeoutMs = o.activateTimeoutMs ?? 5000;
  const selected = new Set(o.transports ?? []);
  const runner = new FeatureRunner({ emit: state.emit, locks: o.locks === undefined ? defaultLocks() : o.locks });
  const known = new Map<string, Known>();
  const committed: Committed[] = [];
  const keys = new Map<ResolveEntry, string>();

  const reportKey = (entry: ResolveEntry): string => {
    let k = keys.get(entry);
    if (!k) {
      k = state.get(entry.def.id) ? `${entry.def.id}#${keys.size}` : entry.def.id;
      keys.set(entry, k);
    }
    return k;
  };

  const spacesFacade = (def: ModuleDefinition): SpacesFacade => ({
    list: async () => (o.spaces ? (await o.spaces.list()).map((s) => s.id as SpaceId) : []),
    ...(def.access?.spaces?.manage && o.spaces ? { admin: o.spaces } : {}),
  });

  const contextFor = (def: ModuleDefinition): ModuleContext =>
    makeContext({
      moduleId: def.id,
      version: def.version,
      settings: o.settings?.[def.id],
      data: createFacade({ core, registry, moduleId: def.id, emit: state.emit }),
      spaces: spacesFacade(def),
      log,
    });

  /** Registers everything the module declared, or nothing. Returns the started features. */
  async function commit(def: ModuleDefinition, ctx: ModuleContext): Promise<FeatureHandle[]> {
    const p = def.provides ?? {};
    const types = p.types ?? [];
    const problems = types.flatMap((t) => checkSchema(t));
    if (problems.length) throw new Error(`invalid schema:\n- ${problems.join('\n- ')}`);

    // elements first: build and pre-check, because a defined element can never be undefined
    const elements: Array<[string, CustomElementConstructor]> = [];
    if (typeof customElements !== 'undefined' && o.defineViews !== false) {
      for (const [name, factory] of Object.entries(p.views ?? {})) {
        const full = `${def.id}-${name}`;
        if (customElements.get(full)) throw new Error(`custom element "${full}" is already defined`);
        elements.push([full, wrapElement(factory(ctx), { ctx, module: def.id, name: full, emit: state.emit })]);
      }
    }

    const registered: string[] = [];
    const typed: string[] = [];
    const added: string[] = [];
    try {
      for (const t of types) {
        registered.push(registry.register(def.id, t).type);
      }
      for (const t of types) {
        const full = `${def.id}.${t.name}`;
        core.registerType(full, { resurrects: t.merge?.editResurrects === true });
        typed.push(full);
      }
      for (const tr of p.transports ?? []) {
        if (!selected.has(`${def.id}.${tr.id}`)) continue;
        const transport = await tr.create(ctx);
        core.addTransport(transport);
        added.push(transport.id);
      }
    } catch (e) {
      for (const id of added) await core.removeTransport(id).catch(() => undefined);
      for (const t of typed) core.unregisterType(t);
      for (const t of registered) registry.unregister(t);
      throw e;
    }

    for (const [name, ctor] of elements) customElements.define(name, ctor);
    const features: FeatureHandle[] = [];
    for (const f of p.features ?? []) features.push(await runner.start(def.id, f, ctx));
    return features;
  }

  async function activate(entry: ResolveEntry): Promise<void> {
    const { def } = entry;
    const key = reportKey(entry);
    const fail = (status: 'failed' | 'skipped', reason: string) => {
      state.patch(key, { status, reason });
      known.set(def.id, { version: def.version, ok: false, reason });
      state.emit({ kind: status === 'failed' ? 'module:failed' : 'module:skipped', id: def.id, reason });
    };

    for (const dep of Object.keys(def.dependencies ?? {})) {
      const k = known.get(dep);
      if (k && !k.ok) return fail('skipped', `dependency "${dep}" failed: ${k.reason ?? 'unavailable'}`);
    }

    const ctx = contextFor(def);
    try {
      if (def.activate) await withTimeout(Promise.resolve().then(() => def.activate!(ctx)), timeoutMs, `activate of module "${def.id}"`);
      const features = await commit(def, ctx);
      committed.push({ def, features });
      state.patch(key, { status: 'active', reason: undefined });
      known.set(def.id, { version: def.version, ok: true });
      state.emit({ kind: 'module:registered', id: def.id });
    } catch (e) {
      log.error(`module "${def.id}" failed: ${message(e)}`);
      fail('failed', message(e));
    }
  }

  const host: Host = {
    registry,
    core,

    async start() {
      const res = resolveModules(o.entries, known);
      for (const r of res.results) {
        const key = reportKey(r.entry);
        state.upsert(key, newReport(r.entry, r.status === 'resolved' ? 'resolved' : r.status, r.reason));
        if (r.status !== 'resolved') {
          state.emit({ kind: r.status === 'failed' ? 'module:failed' : 'module:skipped', id: r.entry.def.id, reason: r.reason! });
          if (!known.has(r.entry.def.id)) known.set(r.entry.def.id, { version: r.entry.def.version, ok: false, reason: r.reason });
        }
      }
      for (const entry of res.order) await activate(entry);
    },

    report: (): ModuleReport[] => state.list(),
    on: (cb) => state.on(cb),

    // device-local Space bindings; persisted in US5 (T090, T091)
    async bindSpace() {},
    async unbindSpace() {},

    // runtime module updates and service worker updates; wired in US3/US4
    async checkForUpdates() {},
    async applyUpdate() {},

    async stop() {
      for (const c of committed.splice(0).reverse()) {
        for (const f of c.features) await f.stop();
        try {
          await c.def.deactivate?.();
        } catch (e) {
          log.warn(`module "${c.def.id}" deactivate failed: ${message(e)}`);
        }
        const key = [...keys.entries()].find(([en]) => en.def === c.def)?.[1];
        if (key) state.patch(key, { status: 'stopped' });
      }
    },
  };
  return host;
}
