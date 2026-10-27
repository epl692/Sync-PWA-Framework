import type { ModuleDefinition } from '../types';

/** Identity function that gives a module definition its types. A no-op at runtime. */
export function defineModule<T extends ModuleDefinition>(def: T): T {
  return def;
}
