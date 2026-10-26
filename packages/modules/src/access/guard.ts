/** What one module may touch: the types and Spaces it declared (FR-012). */

import type { EffectiveAccess, HostEvent } from '../types';
import { AccessDeniedError } from './errors';
import type { Bindings } from './bindings';

/** Decides what a module may touch. `type` and `space` throw AccessDeniedError; `can*` only answer. */
export interface Guard {
  type(mode: 'r' | 'rw', type: string): void;
  space(mode: 'r' | 'rw', space: string): void;
  canType(mode: 'r' | 'rw', type: string): boolean;
  canSpace(mode: 'r' | 'rw', space: string): boolean;
  /** Raise AccessDeniedError for something the module may not do. `detail` goes to the host event, not to the module. */
  deny(what: string, detail?: string): never;
  /** The module's access changed (a Space was bound or unbound). */
  onChange(cb: () => void): () => void;
}

export const allowAll: Guard = {
  type() {},
  space() {},
  canType: () => true,
  canSpace: () => true,
  deny(what) {
    throw new AccessDeniedError('', what);
  },
  onChange: () => () => undefined,
};

export function createGuard(o: { moduleId: string; access: EffectiveAccess; bindings: Bindings; emit(e: HostEvent): void }): Guard {
  const { moduleId, access, bindings } = o;
  const read = new Set(access.types.read);
  const write = new Set(access.types.write);

  const canType = (mode: 'r' | 'rw', type: string) => (mode === 'r' ? read : write).has(type);
  const canSpace = (mode: 'r' | 'rw', space: string) => {
    const scope = mode === 'r' ? access.spaces.read : access.spaces.write;
    return scope === 'any' || bindings.allows(moduleId, space, mode);
  };
  const verb = (mode: 'r' | 'rw') => (mode === 'r' ? 'read' : 'write');

  const deny = (what: string, detail?: string): never => {
    o.emit({ kind: 'access:denied', module: moduleId, what: detail ? `${what} (${detail})` : what });
    throw new AccessDeniedError(moduleId, what);
  };

  return {
    type(mode, type) {
      if (!canType(mode, type)) deny(`${verb(mode)} ${type}`, `${type} is not in the module's declared ${verb(mode)} types`);
    },
    space(mode, space) {
      if (!canSpace(mode, space)) deny(`${verb(mode)} Space ${space}`, `Space ${space} is not ${access.spaces[mode === 'r' ? 'read' : 'write'] === 'bound' ? 'bound to the module for ' + verb(mode) : 'available'}`);
    },
    canType,
    canSpace,
    deny,
    onChange: (cb) => bindings.onChange(cb),
  };
}
