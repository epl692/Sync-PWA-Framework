/** startApp: resolve, open the secure core, activate, then bring in runtime modules (research R-05, R-08, R-13). */

import { createIndexedDbStorage, type SyncCore } from '@sync/core';
import { assertSecureCore, openSecureCore, type IdentityProvider, type Spaces } from '@sync/spaces';
import { Bindings, indexedDbBindingDb, memoryBindingDb } from '../access/bindings';
import { bootFacades, consoleLogger, makeContext } from '../host/context';
import { createHost, type Host } from '../host/host';
import { resolveModules, type ResolveEntry } from '../host/resolve';
import { RuntimeLoader, type LoadedModule } from '../loader/runtime';
import type { ParsedManifest } from '../loader/manifest';
import { UpdateChecker, applyModuleUpdates } from '../loader/update';
import type { HostEvent, IdentityProviderDef, ModuleHost } from '../types';
import type { AppConfig, StartOptions } from './config';
import { registerServiceWorker, type SwHandle } from './sw-register';

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function startApp(config: AppConfig, options: StartOptions = {}): Promise<ModuleHost> {
  const mode = options.mode ?? 'production';
  if (config.security === 'plaintext-for-tests') {
    if (mode === 'production') throw new Error('security "plaintext-for-tests" is not allowed in a production build');
    if (!options.core) throw new Error('security "plaintext-for-tests" needs options.core (a core built with the test codec)');
  }

  // events that happen before the host exists (runtime loading during boot) are replayed once it does
  const created: { host?: Host } = {};
  const early: HostEvent[] = [];
  const emit = (e: HostEvent) => (created.host ? created.host.emit(e) : void early.push(e));

  // 1. resolve what is bundled, and bring in the runtime modules that must exist before the core opens
  const bundled: ResolveEntry[] = config.modules.map((def) => ({ def, source: 'bundled' }));
  const runtime = createRuntime(config, options, emit);
  let firstManifest: ParsedManifest | undefined;
  const bootLoaded: LoadedModule[] = [];
  if (runtime) {
    // The cached manifest is instant and works offline. A very first launch has no cache: it only waits for the network
    // (bounded by the timeout) when the app says it has `boot: true` modules; otherwise bundled modules never wait.
    firstManifest = (await runtime.cachedManifest()) ?? (config.runtime?.waitForBoot ? await runtime.fetchManifest() : undefined);
    bootLoaded.push(...(await runtime.loadAll(firstManifest?.entries.filter((e) => e.boot) ?? [])));
  }
  const entries: ResolveEntry[] = [
    ...bundled,
    ...bootLoaded.flatMap((l) => (l.outcome.ok ? [{ def: l.outcome.def, source: 'runtime' as const, boot: true, stale: l.outcome.stale }] : [])),
  ];
  const resolved = resolveModules(entries);

  // 2. open the core, which needs the identity provider first
  let core: SyncCore;
  let spaces: Spaces | undefined;
  if (options.core) {
    ({ core, spaces } = { core: options.core, spaces: options.spaces });
  } else {
    const provider = await createProvider(config, resolved.order);
    const storage = options.storage ?? (await createIndexedDbStorage());
    ({ core, spaces } = await openSecureCore({ provider, keyDb: options.keyDb, now: options.now, core: { storage, now: options.now } }));
  }
  if (config.security !== 'plaintext-for-tests') assertSecureCore(core);
  const blobsFactory = options.blobs ?? config.blobs;
  const blobs = blobsFactory ? await blobsFactory({ core, spaces }) : undefined;

  // 3. activate
  const bindings = await Bindings.open(options.bindingDb ?? (typeof indexedDB !== 'undefined' ? indexedDbBindingDb() : memoryBindingDb()));
  const h = createHost({
    core,
    spaces,
    blobs,
    bindings,
    entries,
    settings: config.settings,
    transports: config.transports,
    activateTimeoutMs: config.runtime?.activateTimeoutMs,
  });
  created.host = h;
  early.splice(0).forEach((e) => h.emit(e));
  for (const l of bootLoaded) {
    if (!l.outcome.ok) h.markRuntime({ id: l.entry.id, version: l.entry.version, status: l.outcome.reason === 'unavailable' ? 'unavailable' : 'refused', reason: l.outcome.detail });
  }
  await h.start();

  if (config.onReady && spaces) {
    try {
      await config.onReady(h, spaces);
    } catch (e) {
      consoleLogger.error(`onReady failed: ${message(e)}`);
    }
  }

  // 4. everything else is the shell's concern and never delays the app
  let sw: SwHandle | undefined;
  if (options.serviceWorker !== false) void registerServiceWorker({ emit: h.emit }).then((s) => void (sw = s));

  let checker: UpdateChecker | undefined;
  let backstop: ReturnType<typeof setTimeout> | undefined;
  if (runtime) {
    const active = () => new Map(h.report().filter((r) => r.source === 'runtime' && (r.status === 'active' || r.status === 'stale')).map((r) => [r.id, r.version] as const));
    checker = new UpdateChecker({ runtime, activeVersions: active, emit: h.emit });
    if (typeof window !== 'undefined' && typeof document !== 'undefined') checker.attach(window, document);
    const bootWindowMs = config.runtime?.bootWindowMs ?? 10_000;
    backstop = setTimeout(() => void h.closeBootWindow(), bootWindowMs);
    const settled = loadRuntimeModules(h, runtime, firstManifest, bootLoaded).finally(async () => {
      clearTimeout(backstop);
      await h.closeBootWindow();
    });
    h.ready = () => settled;
  } else {
    await h.closeBootWindow();
  }

  h.checkForUpdates = () => (checker ? checker.check(true) : Promise.resolve());
  h.applyUpdate = async () => {
    await applyModuleUpdates();
    await sw?.applyServiceWorkerUpdate();
    if (typeof location !== 'undefined') location.reload();
  };

  const stop = h.stop.bind(h);
  h.stop = async () => {
    clearTimeout(backstop);
    await stop();
    await blobs?.close();
    await spaces?.close();
    await core.close();
  };
  return h;
}

/** The runtime loader, or undefined when the app has none (disabled in the config, or not running in a page). */
function createRuntime(config: AppConfig, options: StartOptions, emit: (e: HostEvent) => void): RuntimeLoader | undefined {
  if (config.runtime?.manifest === false) return undefined;
  const inPage = typeof document !== 'undefined' && typeof location !== 'undefined';
  const r = options.runtime;
  if (!inPage && !r?.manifestUrl) return undefined;
  const manifestUrl = r?.manifestUrl ?? new URL(config.runtime?.manifest ?? 'modules/manifest.json', document.baseURI).href;
  return new RuntimeLoader({
    manifestUrl,
    origin: r?.origin ?? new URL(manifestUrl).origin,
    bundledIds: new Set(config.modules.map((m) => m.id)),
    emit,
    fetch: r?.fetch,
    cache: r?.cache,
    importModule: r?.importModule,
    integrityOf: r?.integrityOf,
    manifestTimeoutMs: config.runtime?.manifestTimeoutMs,
  });
}

/** Load the rest of the manifest (fresh if the network answers) and activate what arrives. */
async function loadRuntimeModules(host: Host, runtime: RuntimeLoader, first: ParsedManifest | undefined, bootLoaded: readonly LoadedModule[]): Promise<void> {
  const fresh = (await runtime.fetchManifest()) ?? first;
  if (!fresh || fresh.unsupported) return;
  const done = new Set(bootLoaded.map((l) => l.entry.id));
  const loaded = await runtime.loadAll(fresh.entries.filter((e) => !done.has(e.id)));
  await runtime.prune(fresh);
  const entries: ResolveEntry[] = [];
  for (const l of loaded) {
    if (l.outcome.ok) entries.push({ def: l.outcome.def, source: 'runtime', stale: l.outcome.stale });
    else host.markRuntime({ id: l.entry.id, version: l.entry.version, status: l.outcome.reason === 'unavailable' ? 'unavailable' : 'refused', reason: l.outcome.detail });
  }
  await host.addModules(entries);
}

async function createProvider(config: AppConfig, order: readonly ResolveEntry[]): Promise<IdentityProvider> {
  const candidates = order.flatMap((entry) =>
    (entry.def.provides?.identityProviders ?? []).map((def) => ({ full: `${entry.def.id}.${def.id}`, def, entry })),
  );
  const chosen = config.identityProvider ? candidates.find((c) => c.full === config.identityProvider) : candidates[0];
  if (config.identityProvider && !chosen) {
    throw new Error(`identity provider "${config.identityProvider}" is not provided by any module that could start`);
  }
  if (!chosen) throw new Error('no identity provider: add a module that provides one (provides.identityProviders) or set config.identityProvider');
  const { def, entry } = chosen;
  const ctx = makeContext({
    moduleId: entry.def.id,
    version: entry.def.version,
    settings: config.settings?.[entry.def.id],
    log: consoleLogger,
    ...bootFacades(),
  });
  try {
    return await (def as IdentityProviderDef).create(ctx);
  } catch (e) {
    throw new Error(`identity provider "${chosen.full}" failed to start: ${message(e)}`);
  }
}
