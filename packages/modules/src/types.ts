/**
 * The Module contract (FR-001..FR-003, FR-007..FR-012). Modules import ONLY types from here
 * (research R-03); everything at runtime arrives through `ModuleContext`.
 * Source of truth: specs/003-modules-app-assembly/contracts/module-api.ts
 */

import type { JSONValue, ObjectId, Query, QuerySpec, SpaceId, SyncCore, Transport, UNSET } from '@sync/core';
import type { IdentityProvider, Spaces } from '@sync/spaces';
import type { ObjectTypeDef } from './schema/types';

export type { ObjectTypeDef } from './schema/types';

// ---------- definition ----------

export interface ModuleDefinition {
  /** ^[a-z][a-z0-9]{1,23}$ . Prefixes every type (`id.name`) and element (`id-name`). */
  id: string;
  /** Semver `x.y.z`. */
  version: string;
  /** Module ID -> semver range (`1.2.3`, `^1.2.0`, `~1.2.0`, `>=1.0.0`). One active version per ID. */
  dependencies?: Record<string, string>;
  access?: AccessDeclaration;
  provides?: Provides;
  /** Runs once during activation (after the core is open). Throwing or exceeding the timeout rolls the module back. */
  activate?(ctx: ModuleContext): void | Promise<void>;
  /** Runs when the host shuts down. Errors are logged and ignored. */
  deactivate?(): void | Promise<void>;
}

export interface Provides {
  types?: readonly ObjectTypeDef[];
  /** Local element name -> factory. Registered as `<moduleId>-<name>`. */
  views?: Record<string, ViewFactory>;
  features?: readonly FeatureDef[];
  transports?: readonly TransportDef[];
  identityProviders?: readonly IdentityProviderDef[];
}

export type ViewFactory = (ctx: ModuleContext) => CustomElementConstructor;

export interface FeatureDef {
  /** Local ID; unique per module. */
  id: string;
  /** Default true: runs in one tab per origin (Web Locks). false: runs in every tab. */
  singleton?: boolean;
  start(ctx: ModuleContext): void | Promise<void> | (() => void);
  stop?(): void | Promise<void>;
}

export interface TransportDef {
  id: string;
  create(ctx: ModuleContext): Transport | Promise<Transport>;
}
export interface IdentityProviderDef {
  id: string;
  create(ctx: ModuleContext): IdentityProvider | Promise<IdentityProvider>;
}

// ---------- access (FR-012) ----------

export interface AccessDeclaration {
  /** Full type names (`other.thing`). The module's own types are implicit but still reported. `write` implies `read`. */
  types?: { read?: readonly string[]; write?: readonly string[] };
  /** `any`: every Space the user is in. `bound`: only Spaces the app binds with host.bindSpace(). Default `bound`. */
  spaces?: { read?: SpaceScope; write?: SpaceScope; /** Full Spaces API (create/invite/remove). Default false. */ manage?: boolean };
}

export type SpaceScope = 'any' | 'bound';

export interface EffectiveAccess {
  types: { read: string[]; write: string[] };
  spaces: { read: SpaceScope; write: SpaceScope; manage: boolean };
}

// ---------- projected objects ----------

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

// ---------- context ----------

export interface ModuleContext {
  readonly moduleId: string;
  readonly version: string;
  /** App Config settings for this module (`config.settings[moduleId]`). Read-only. */
  readonly settings: Readonly<Record<string, JSONValue>>;
  readonly data: DataFacade;
  readonly spaces: SpacesFacade;
  readonly ui: { LiveElement: LiveElementConstructor };
  readonly log: { info(msg: string, extra?: unknown): void; warn(msg: string, extra?: unknown): void; error(msg: string, extra?: unknown): void };
}

export type FacadeQuerySpec = Omit<QuerySpec, 'where' | 'withClocks'> & { where?: (obj: ProjectedObject) => boolean };

/** Same method names as SyncCore for objects and queries; every call is checked against `access`. */
export interface DataFacade {
  /** `type` is the full name. Validated against the schema before any packet exists (SchemaValidationError). */
  create(space: SpaceId, type: string, fields: Record<string, JSONValue>): Promise<ProjectedObject>;
  update(id: ObjectId, fields: Record<string, JSONValue | typeof UNSET>): Promise<ProjectedObject>;
  remove(id: ObjectId): Promise<void>;
  get(id: ObjectId): Promise<ProjectedObject | undefined>;
  /** `type` is required (or `id`). Results are projected to the current schema version. */
  query(spec: FacadeQuerySpec): Query<ProjectedObject>;
  undo(id: ObjectId): Promise<void>;
  history: SyncCore['history'];
}

export interface SpacesFacade {
  /** Space IDs this module may use for the given mode. */
  list(mode: 'r' | 'rw'): Promise<SpaceId[]>;
  /** Only present when `access.spaces.manage` is true. The keystore is never exposed. */
  admin?: Spaces;
}

/** Base class for views (see ui/live-element.ts). Plain `HTMLElement` subclasses work too. */
export interface LiveElementInstance extends HTMLElement {
  /** Injected by the host wrapper. */
  readonly ctx: ModuleContext;
  /**
   * Subscribe on connect, unsubscribe on disconnect, coalesce to one render per frame, errors contained.
   * Call from `connectedCallback` or the constructor.
   */
  bind(spec: FacadeQuerySpec, render: (rows: ProjectedObject[]) => void): void;
  /** Subclasses that override these MUST call the super version. */
  connectedCallback(): void;
  disconnectedCallback(): void;
}
export interface LiveElementConstructor {
  new (): LiveElementInstance;
  prototype: LiveElementInstance;
}

// ---------- host ----------

export type ModuleStatus = 'resolved' | 'active' | 'failed' | 'skipped' | 'refused' | 'stale' | 'unavailable' | 'stopped';

export interface ModuleReport {
  id: string;
  version: string;
  source: 'bundled' | 'runtime';
  status: ModuleStatus;
  reason?: string;
  dependencies: Record<string, string>;
  /** What it declared (US5-2): developers see this without running the module. */
  access: EffectiveAccess;
  registers: { types: string[]; views: string[]; features: string[]; transports: string[]; identityProviders: string[] };
}

export type HostEvent =
  | { kind: 'module:registered'; id: string }
  | { kind: 'module:failed'; id: string; reason: string }
  | { kind: 'module:skipped'; id: string; reason: string }
  | { kind: 'module:refused'; id: string | undefined; url?: string; reason: 'cross-origin' | 'bad-scheme' | 'id-clash' | 'integrity' | 'provider-after-boot' | 'malformed' }
  | { kind: 'module:stale'; id: string; cachedVersion: string }
  | { kind: 'module:unavailable'; id: string }
  | { kind: 'module:update-available'; id: string; version: string }
  | { kind: 'view:error'; module: string; element: string; error: string }
  | { kind: 'feature:stopped'; module: string; feature: string; error: string }
  | { kind: 'access:denied'; module: string; what: string }
  | { kind: 'schema:violation'; type: string; obj: ObjectId; field: string; detail: string }
  | { kind: 'schema:breaking'; type: string; version: number }
  | { kind: 'app:offline-ready' }
  | { kind: 'app:update-ready' }
  | { kind: 'sw:unavailable'; reason: string };

export interface ModuleHost {
  /** Statuses, declarations and registrations for every module seen (bundled and runtime). */
  report(): ModuleReport[];
  on(cb: (e: HostEvent) => void): () => void;
  /** Bind a Space to a module whose access uses `bound`. Persisted locally (device setting). */
  bindSpace(moduleId: string, space: SpaceId, mode: 'r' | 'rw'): Promise<void>;
  unbindSpace(moduleId: string, space: SpaceId): Promise<void>;
  /** Re-check the runtime manifest and cache newer files; emits module:update-available. */
  checkForUpdates(): Promise<void>;
  /** Take effect of cached runtime-module updates and a waiting service worker: reloads the page. */
  applyUpdate(): Promise<void>;
  /** Resolves when runtime module loading has settled (immediately when the app has none). */
  ready(): Promise<void>;
  readonly core: SyncCore;
  stop(): Promise<void>;
}
