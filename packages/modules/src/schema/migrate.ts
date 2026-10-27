/**
 * Helpers for `up` and `down` (research R-07). Every helper decides by clock: when the old and the new field
 * were both written, the later write wins; a tie keeps the natively written (newer-version) value.
 */

import type { JSONValue } from '@sync/core';
import { DERIVED, type ClockedFields, type Derived, type MigrationResult, type UpFn } from './types';

export function derive(value: JSONValue | undefined, clock: string): Derived {
  return { [DERIVED]: true, value, clock };
}

export function isDerived(x: unknown): x is Derived {
  return typeof x === 'object' && x !== null && (x as Record<symbol, unknown>)[DERIVED] === true;
}

/** Take `from`'s write when it is strictly newer than what `to` already has (or `to` was never written). */
const newer = (prev: ClockedFields, own: ClockedFields, from: string, to: string): string | undefined => {
  const pc = prev.clock(from);
  if (pc === undefined) return undefined; // the old field was never written
  const oc = own.clock(to);
  return oc === undefined || pc > oc ? pc : undefined;
};

export const migrate = {
  /** `to` takes over `from`'s value, unless `to` was written later. A removed `from` removes `to`. */
  rename(from: string, to: string): UpFn {
    return (prev, own) => {
      const clock = newer(prev, own, from, to);
      return clock === undefined ? {} : { [to]: derive(prev.get(from), clock) };
    };
  },

  /** Like `rename`, with the value converted. `fn` is only called for a value that is set. */
  convert(from: string, to: string, fn: (v: JSONValue) => JSONValue): UpFn {
    return (prev, own) => {
      const clock = newer(prev, own, from, to);
      if (clock === undefined) return {};
      const v = prev.get(from);
      return { [to]: derive(v === undefined ? undefined : fn(v), clock) };
    };
  },

  /** A value for `field` when nothing, not even an unset, was ever written to it. Any real write beats it. */
  addDefault(field: string, value: JSONValue): UpFn {
    return (prev, own) => (prev.clock(field) === undefined && own.clock(field) === undefined ? { [field]: derive(value, '') } : {});
  },

  /** Run independent steps on the same inputs and merge their results; a later step wins on the same field. */
  all(...steps: UpFn[]): UpFn {
    return (prev, own) => {
      const out: MigrationResult = {};
      for (const s of steps) Object.assign(out, s(prev, own));
      return out;
    };
  },

  /** For `down`: write `to` (an older version's name) whenever `from` (this version's name) is written. */
  mirrorRename(from: string, to: string): (changed: Record<string, JSONValue>) => MigrationResult {
    return (changed) => (from in changed ? { [to]: changed[from] } : {});
  },
};
