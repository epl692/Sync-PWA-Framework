import type { EffectiveAccess, ModuleDefinition } from '../types';

const uniqSorted = (xs: Iterable<string>) => [...new Set(xs)].sort();

/**
 * The declaration the host enforces and reports (US5-2). A module's own types are implicit; `write`
 * implies `read`; Space scopes default to `bound` and the full Spaces API is off unless `manage`.
 */
export function normalizeAccess(def: ModuleDefinition): EffectiveAccess {
  const own = (def.provides?.types ?? []).map((t) => `${def.id}.${t.name}`);
  const declaredWrite = def.access?.types?.write ?? [];
  const declaredRead = def.access?.types?.read ?? [];
  return {
    types: {
      read: uniqSorted([...own, ...declaredRead, ...declaredWrite]),
      write: uniqSorted([...own, ...declaredWrite]),
    },
    spaces: {
      read: def.access?.spaces?.read ?? 'bound',
      write: def.access?.spaces?.write ?? 'bound',
      manage: def.access?.spaces?.manage ?? false,
    },
  };
}
