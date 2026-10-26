/**
 * The Module contract (FR-001..FR-003, FR-007..FR-012). Modules import ONLY types from here.
 * Everything at runtime arrives through `ModuleContext` (research R-03), so bundled and
 * runtime-loaded modules are identical.
 */

import type { SyncCore, SyncableObject, ObjectId, SpaceId, JSONValue, UNSET, Query, QuerySpec } from '../../001-sync-core/contracts/public-api';
import type { Transport } from '../../001-sync-core/contracts/transport';
import type { IdentityProvider } from '../../002-spaces-security-identity/contracts/identity-provider';
import type { ObjectTypeDef, ProjectedObject } from './schema';

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

export interface TransportDef { id: string; create(ctx: ModuleContext): Transport | Promise<Transport> }
export interface IdentityProviderDef { id: string; create(ctx: ModuleContext): IdentityProvider | Promise<IdentityProvider> }

// ---------- access (FR-012) ----------

export interface AccessDeclaration {
  /** Full type names (`other.thing`). The module's own types are implicit but still reported. `write` implies `read`. */
  types?: { read?: readonly string[]; write?: readonly string[] };
  /** `any`: every Space the user is in. `bound`: only Spaces the app binds with host.bindSpace(). Default `bound`. */
  spaces?: { read?: 'any' | 'bound'; write?: 'any' | 'bound'; /** Full Spaces API (create/invite/remove). Default false. */ manage?: boolean };
}

export class AccessDeniedError extends Error {
  readonly code = 'access-denied';
  /** Same error for "undeclared type", "unbound Space" and "no such object": the facade is not an existence oracle. */
  constructor(readonly module: string, readonly what: string) { super(`module "${module}" may not ${what}`); }
}

// ---------- context ----------

export interface ModuleContext {
  readonly moduleId: string;
  readonly version: string;
  /** App Config settings for this module (`config.settings[moduleId]`). Read-only. */
  readonly settings: Readonly<Record<string, JSONValue>>;
  readonly data: DataFacade;
  readonly spaces: SpacesFacade;
  readonly ui: { LiveElement: typeof LiveElement };
  readonly log: { info(msg: string, extra?: unknown): void; warn(msg: string, extra?: unknown): void; error(msg: string, extra?: unknown): void };
}

/** Same method names as SyncCore for objects and queries; every call is checked against `access`. */
export interface DataFacade {
  /** `type` is the full name. Validated against the schema before any packet exists (SchemaValidationError). */
  create(space: SpaceId, type: string, fields: Record<string, JSONValue>): Promise<ProjectedObject>;
  update(id: ObjectId, fields: Record<string, JSONValue | typeof UNSET>): Promise<ProjectedObject>;
  remove(id: ObjectId): Promise<void>;
  get(id: ObjectId): Promise<ProjectedObject | undefined>;
  /** `type` is required (or `id`). Results are projected to the current schema version. */
  query(spec: Omit<QuerySpec, 'where'> & { type?: string; where?: (obj: ProjectedObject) => boolean }): Query<ProjectedObject>;
  undo(id: ObjectId): Promise<void>;
  history: SyncCore['history'];
}

export interface SpacesFacade {
  /** Space IDs this module may use for the given mode. */
  list(mode: 'r' | 'rw'): Promise<SpaceId[]>;
  /** Only present when `access.spaces.manage` is true; otherwise undefined. The keystore is never exposed. */
  admin?: import('../../002-spaces-security-identity/contracts/spaces-api').Spaces;
}

/** Optional base class for views. Plain `HTMLElement` subclasses work too (R-11). */
export declare class LiveElement extends HTMLElement {
  /** Injected by the host wrapper. */
  readonly ctx: ModuleContext;
  /**
   * Subscribe on connect, unsubscribe on disconnect, coalesce to one render per frame, errors contained.
   * Call from `connectedCallback` or the constructor.
   */
  protected bind<T = ProjectedObject>(spec: Parameters<DataFacade['query']>[0], render: (rows: ProjectedObject[]) => void): void;
}

// ---------- host ----------

export type ModuleStatus =
  | 'resolved'
  | 'active'
  | 'failed'    // threw, timed out, or violated a rule; see `reason`
  | 'skipped'   // dependency missing, failed, or version-unsatisfied
  | 'refused'   // runtime entry rejected (origin, id clash, integrity, boot rule)
  | 'stale'     // active from a cached runtime copy because the network copy was unavailable
  | 'unavailable'; // runtime module not loadable and no cache

export interface ModuleReport {
  id: string;
  version: string;
  source: 'bundled' | 'runtime';
  status: ModuleStatus;
  reason?: string;
  dependencies: Record<string, string>;
  /** What it declared (US5-2): developers see this without running the module. */
  access: Required<{ types: { read: string[]; write: string[] } }> & { spaces: { read: 'any' | 'bound'; write: 'any' | 'bound'; manage: boolean } };
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
  | { kind: 'app:update-ready' };

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
  readonly core: SyncCore;
  stop(): Promise<void>;
}

export declare function defineModule<T extends ModuleDefinition>(def: T): T;

// ---------- contract test suite (Principle VIII) ----------

/**
 * Exported from @sync/testkit. Runs against any ModuleDefinition: id/name rules, schema lint,
 * clean activation and deactivation, access declarations honored (denial of an undeclared type),
 * isolation (activation failure does not affect a sibling host), and projection of mixed versions.
 */
export declare function moduleContract(opts: { name: string; definition: ModuleDefinition; fixtures?: Record<string, Array<Record<string, JSONValue>>> }): void;
