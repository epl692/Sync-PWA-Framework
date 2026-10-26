import type { JSONValue } from '@sync/core';
import type { ClockedFields } from './types';

export interface ClockedEntry {
  /** `undefined` for a field that was unset (it still has the clock of the unset). */
  value: JSONValue | undefined;
  clock: string;
}

/** A read-only view of fields with the clocks of their last writes. */
export function clockedFields(entries: ReadonlyMap<string, ClockedEntry>): ClockedFields {
  return {
    get: (name) => entries.get(name)?.value,
    clock: (name) => entries.get(name)?.clock,
    has: (name) => entries.get(name)?.value !== undefined,
  };
}

/** The greatest clock in a view, or '' for an empty one. */
export function maxClockOf(entries: ReadonlyMap<string, ClockedEntry>): string {
  let m = '';
  for (const e of entries.values()) if (e.clock > m) m = e.clock;
  return m;
}
