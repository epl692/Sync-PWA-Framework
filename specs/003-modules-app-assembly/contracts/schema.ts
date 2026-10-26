/**
 * Object type schemas (FR-004..FR-006). Plain data, no imports at runtime, so a schema
 * can live in a bundled or a runtime-loaded module. See schema-rules.md for the rules.
 */

import type { JSONValue, SyncableObject } from '../../001-sync-core/contracts/public-api';

// ---------- fields ----------

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
  | { type: 'list'; of: 'string' | 'number' | 'boolean'; required?: boolean; maxItems?: number; check?: Check<JSONValue[]> };

/** Must be pure: no clock, no I/O, no other objects. Return a message to reject, nothing to accept. */
export type Check<T> = (value: T) => string | undefined;

// ---------- versions and migrations ----------

/** Field values with the clocks of the writes that set them (core amendment C-2). */
export interface ClockedFields {
  get(name: string): JSONValue | undefined;
  /** Serialized HLC of the last write to this field, or undefined if never set. */
  clock(name: string): string | undefined;
  has(name: string): boolean;
}

/** Output of `up`/`down`: fields to expose, with their value; `undefined` means not set. */
export type MigrationResult = Record<string, JSONValue | undefined>;

export interface SchemaVersion {
  /** 1, 2, 3 ... contiguous. */
  version: number;
  /** Complete field list of this version (not a diff), so packets of this version can be validated alone. */
  fields: Record<string, FieldDef>;
  /**
   * Required for version > 1. Pure. Computes this version's fields from the PREVIOUS version's fields
   * (and, where both exist, this version's fields), choosing by clock. Run at read time only.
   * Prefer the helpers in `migrate`.
   */
  up?: (prev: ClockedFields, own: ClockedFields) => MigrationResult;
  /**
   * Optional. Maps changed fields of THIS version into the PREVIOUS version's field names so older
   * peers still see the change. The host calls it on every write while `compatWrite` includes the older version.
   */
  down?: (changed: Record<string, JSONValue | typeof UNSET_MARK>) => MigrationResult;
  /** Set when no `down` can exist (lossy change). Required in that case; the host logs the consequence. */
  breaking?: boolean;
  /** Create-only rule over the complete field set. */
  objectCheck?: (fields: Record<string, JSONValue>) => string | undefined;
}

declare const UNSET_MARK: unique symbol;

/** Declarative migration helpers (all clock-aware: when old and new both exist, the newer write wins). */
export interface MigrateHelpers {
  rename(from: string, to: string): (prev: ClockedFields, own: ClockedFields) => MigrationResult;
  convert(from: string, to: string, fn: (v: JSONValue) => JSONValue): (prev: ClockedFields, own: ClockedFields) => MigrationResult;
  addDefault(field: string, value: JSONValue): (prev: ClockedFields, own: ClockedFields) => MigrationResult;
  /** Run several in order and merge their results. */
  all(...steps: Array<(prev: ClockedFields, own: ClockedFields) => MigrationResult>): (prev: ClockedFields, own: ClockedFields) => MigrationResult;
}
export declare const migrate: MigrateHelpers;

// ---------- type ----------

export interface MergeOptions {
  /** FR-004/FR-012 in 001: a concurrent edit restores a deleted object. Version-independent. Default false. */
  editResurrects?: boolean;
}

export interface ObjectTypeDef {
  /** Local name; the registered type is `<moduleId>.<name>`. */
  name: string;
  /** Ascending, contiguous from 1. The last entry is the current version. */
  versions: readonly SchemaVersion[];
  merge?: MergeOptions;
  /** Default `${moduleId}.${name}` fields shown in debugging UIs. Optional. */
  label?: string;
  /**
   * Oldest version that is still mirrored via `down` on writes. Default: current - 1 when the current
   * version defines `down`, otherwise current (no mirroring).
   */
  compatWrite?: number;
}

// ---------- registry, validator, projection ----------

export class SchemaValidationError extends Error {
  readonly code = 'schema-validation';
  constructor(readonly type: string, readonly field: string | undefined, readonly detail: string) { super(`${type}${field ? '.' + field : ''}: ${detail}`); }
}

export interface RegisteredType {
  type: string;            // "<moduleId>.<name>"
  module: string;
  def: ObjectTypeDef;
  latest: number;
}

export interface SchemaRegistry {
  /** Throws on a lint failure (see checkSchema) or a duplicate type name. */
  register(module: string, def: ObjectTypeDef): RegisteredType;
  unregister(type: string): void;
  get(type: string): RegisteredType | undefined;
  list(): RegisteredType[];
}

/** Lint used at registration, by `check-modules`, and by the module contract suite. Returns problems; empty = ok. */
export declare function checkSchema(def: ObjectTypeDef): string[];

export type ValidationOutcome = { ok: true } | { ok: false; field?: string; detail: string };

/**
 * Pure validation of one packet body against its own schema version (schema-rules.md §1).
 * `schemaVersion > latest` is lenient: known field names are type-checked, unknown ones pass through.
 */
export declare function validateBody(reg: RegisteredType, body: { op: 'create' | 'update' | 'delete'; schemaVersion: number; fields: Record<string, JSONValue> }): ValidationOutcome;

export interface ProjectedObject<T = Record<string, JSONValue>> {
  id: string;
  type: string;
  space: string;
  /** Fields of the CURRENT version after read-time migration; invalid stored values are omitted. */
  fields: Partial<T>;
  /** Version of the newest write seen for this object (may exceed the registered latest). */
  seenVersion: number;
  /** Fields the schema rejected on read (opaque data that arrived before the schema was known). */
  violations?: Array<{ field: string; detail: string }>;
}

export declare function project(reg: RegisteredType, obj: SyncableObject): ProjectedObject;

/** Fills defaults and writes `down` mirrors; used by the data facade before calling the core. */
export declare function prepareWrite(reg: RegisteredType, op: 'create' | 'update', fields: Record<string, JSONValue>): { schemaVersion: number; fields: Record<string, JSONValue> };

// ---------- core integration ----------

import type { PacketValidator } from '../../001-sync-core/contracts/extension-points';

/** One validator registered once with the core; serves phases 'send' and 'apply'. */
export interface SchemaValidator extends PacketValidator {
  /** Window in which unknown types are deferred (R-09). After `closeBootWindow()` they are accepted as opaque. */
  closeBootWindow(): void;
}
export declare function createSchemaValidator(registry: SchemaRegistry): SchemaValidator;
