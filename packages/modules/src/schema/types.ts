/**
 * Object type schemas (FR-004..FR-006). Plain data with no runtime imports, so a schema can live in a
 * bundled or a runtime-loaded module. Rules: specs/003-modules-app-assembly/contracts/schema-rules.md
 */

import type { JSONValue } from '@sync/core';

/** Must be pure: no clock, no I/O, no other objects. Return a message to reject, nothing to accept. */
export type Check<T> = (value: T) => string | undefined;

export type FieldDef =
  | { type: 'string'; required?: boolean; default?: string; maxLength?: number; pattern?: string; check?: Check<string> }
  | { type: 'number'; required?: boolean; default?: number; min?: number; max?: number; check?: Check<number> }
  | { type: 'integer'; required?: boolean; default?: number; min?: number; max?: number; check?: Check<number> }
  | { type: 'boolean'; required?: boolean; default?: boolean; check?: Check<boolean> }
  /** Milliseconds since epoch. */
  | { type: 'timestamp'; required?: boolean; default?: number; min?: number; max?: number; check?: Check<number> }
  | { type: 'enum'; values: readonly string[]; required?: boolean; default?: string }
  /** Object ID. `to` is a hint for tooling; referential integrity is NOT enforced (objects sync independently). */
  | { type: 'ref'; to?: string; required?: boolean; check?: Check<string> }
  /** Opaque JSON, replaced whole under LWW. */
  | { type: 'json'; required?: boolean; maxBytes?: number; check?: Check<JSONValue> }
  /** List of primitives, replaced whole under LWW (not a CRDT list). */
  | { type: 'list'; of: 'string' | 'number' | 'boolean'; required?: boolean; maxItems?: number; check?: Check<JSONValue[]> }
  /** A list of attachment references (spec 004). `accept` and `maxBytes` apply to every item. */
  | { type: 'list'; of: 'blob'; required?: boolean; maxItems?: number; accept?: readonly string[]; maxBytes?: number; check?: Check<JSONValue[]> }
  /**
   * An attachment reference (spec 004, M-1): `{ $blob: 1, id, size, type, space, scope, keyId, name? }`, opaque JSON to
   * migration and projection. `accept` lists media types (`image/*` or `application/pdf`); `maxBytes` caps `size`.
   */
  | { type: 'blob'; required?: boolean; accept?: readonly string[]; maxBytes?: number; check?: Check<JSONValue> };

export type FieldType = FieldDef['type'];

/** Field values with the clocks of the writes that set them (core amendment C-2). */
export interface ClockedFields {
  get(name: string): JSONValue | undefined;
  /** Serialized HLC of the last write to this field, or undefined if never set. */
  clock(name: string): string | undefined;
  has(name: string): boolean;
}

/**
 * A value an `up` migration derived from older fields, with the clock of the write it came from (so that
 * later steps, and the "newer write wins" rule, can still order it). Build with `derive` in `migrate.ts`.
 */
export interface Derived {
  readonly [DERIVED]: true;
  value: JSONValue | undefined;
  /** When the source was written. `''` sorts before every real clock. */
  clock: string;
}
export const DERIVED: unique symbol = Symbol.for('sync.derived') as never;

/**
 * Output of `up`: the next version's fields this step decides (a field the step does not mention keeps the newer of
 * the earlier version's value and the value written natively). `undefined` removes the field. `down` returns plain
 * values, with `{ "$unset": true }` for a removal, and `undefined` for "nothing to say".
 */
export type MigrationResult = Record<string, JSONValue | undefined | Derived>;

export type UpFn = (prev: ClockedFields, own: ClockedFields) => MigrationResult;

export interface SchemaVersion {
  /** 1, 2, 3 ... contiguous. */
  version: number;
  /** Complete field list of this version (not a diff), so packets of this version can be validated alone. */
  fields: Record<string, FieldDef>;
  /**
   * Required for version > 1. Pure. Decides this version's fields from the PREVIOUS version's fields (`prev`) and the
   * ones written natively at this version (`own`), choosing by clock. Run at read time only; use the helpers in `migrate`.
   */
  up?: UpFn;
  /**
   * Optional. Maps changed fields of THIS version into the PREVIOUS version's field names so older
   * peers still see the change. `{ $unset: true }` is the value of a removed field.
   */
  down?: (changed: Record<string, JSONValue>) => MigrationResult;
  /** Set when no `down` can exist (lossy change). The host logs the consequence. */
  breaking?: boolean;
  /** Create-only rule over the complete field set. */
  objectCheck?: (fields: Record<string, JSONValue>) => string | undefined;
}

export interface MergeOptions {
  /** A concurrent edit restores a deleted object. Type-level, version independent. Default false. */
  editResurrects?: boolean;
}

export interface ObjectTypeDef {
  /** Local name; the registered type is `<moduleId>.<name>`. */
  name: string;
  /** Ascending, contiguous from 1. The last entry is the current version. */
  versions: readonly SchemaVersion[];
  merge?: MergeOptions;
  label?: string;
  /**
   * Oldest version still mirrored via `down` on writes. Default: current - 1 when the current version
   * defines `down`, otherwise current (no mirroring).
   */
  compatWrite?: number;
}

export interface RegisteredType {
  /** "<moduleId>.<name>" */
  type: string;
  module: string;
  def: ObjectTypeDef;
  latest: number;
}

export class SchemaValidationError extends Error {
  readonly code = 'schema-validation';
  constructor(
    readonly type: string,
    readonly field: string | undefined,
    readonly detail: string,
  ) {
    super(`${type}${field ? '.' + field : ''}: ${detail}`);
    this.name = 'SchemaValidationError';
  }
}

export const NAME_RE = /^[a-z][A-Za-z0-9_]{0,31}$/;
