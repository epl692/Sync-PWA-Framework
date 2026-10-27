/** Static checks of an App Config, with no browser and no core: used by the build and by `check-modules`. */

import { checkSchema } from '../schema/lint';
import { resolveModules } from '../host/resolve';
import type { AppConfig } from './config';

/** Every problem found (empty means the config is sound). */
export function checkAppConfig(config: AppConfig): string[] {
  const problems: string[] = [];
  const entries = config.modules.map((def) => ({ def, source: 'bundled' as const }));
  const resolved = resolveModules(entries);
  for (const r of resolved.results) {
    if (r.status !== 'resolved') problems.push(`module "${r.entry.def.id}" ${r.status}: ${r.reason}`);
  }
  for (const def of config.modules) {
    for (const t of def.provides?.types ?? []) for (const p of checkSchema(t)) problems.push(`module "${def.id}": ${p}`);
  }

  const providers = new Set(config.modules.flatMap((d) => (d.provides?.identityProviders ?? []).map((p) => `${d.id}.${p.id}`)));
  const transports = new Set(config.modules.flatMap((d) => (d.provides?.transports ?? []).map((t) => `${d.id}.${t.id}`)));
  if (config.identityProvider && !providers.has(config.identityProvider)) {
    problems.push(`identityProvider "${config.identityProvider}" is not provided by any listed module`);
  }
  for (const t of config.transports ?? []) {
    if (!transports.has(t)) problems.push(`transport "${t}" is not provided by any listed module`);
  }
  if (!config.name) problems.push('config.name is required');
  if (!/^#[0-9a-fA-F]{3,8}$/.test(config.themeColor ?? '')) problems.push(`config.themeColor ${JSON.stringify(config.themeColor)} must be a hex color`);
  return problems;
}
