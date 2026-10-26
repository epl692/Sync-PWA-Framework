/** startApp: resolve, open the secure core, activate (research R-05, R-13). */

import { createIndexedDbStorage, type SyncCore } from '@sync/core';
import { assertSecureCore, openSecureCore, type IdentityProvider, type Spaces } from '@sync/spaces';
import { bootFacades, consoleLogger, makeContext } from '../host/context';
import { createHost } from '../host/host';
import { resolveModules, type ResolveEntry } from '../host/resolve';
import type { IdentityProviderDef, ModuleHost } from '../types';
import type { AppConfig, StartOptions } from './config';

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function startApp(config: AppConfig, options: StartOptions = {}): Promise<ModuleHost> {
  const mode = options.mode ?? 'production';
  if (config.security === 'plaintext-for-tests') {
    if (mode === 'production') throw new Error('security "plaintext-for-tests" is not allowed in a production build');
    if (!options.core) throw new Error('security "plaintext-for-tests" needs options.core (a core built with the test codec)');
  }

  // 1. resolve
  const entries: ResolveEntry[] = config.modules.map((def) => ({ def, source: 'bundled' }));
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

  // 3. activate
  const host = createHost({
    core,
    spaces,
    entries,
    settings: config.settings,
    transports: config.transports,
    activateTimeoutMs: config.runtime?.activateTimeoutMs,
  });
  await host.start();

  if (config.onReady && spaces) {
    try {
      await config.onReady(host, spaces);
    } catch (e) {
      consoleLogger.error(`onReady failed: ${message(e)}`);
    }
  }

  const stop = host.stop.bind(host);
  host.stop = async () => {
    await stop();
    await spaces?.close();
    await core.close();
  };
  return host;
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
