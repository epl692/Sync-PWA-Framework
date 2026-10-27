# Data Model: Modules & App Assembly

Entities from the spec, with fields, relationships, validation, and state transitions. Types are in [contracts/](./contracts/). This feature adds **no new synced object types and no new wire fields**; its state is definitions (code), device-local settings, and caches.

## Entities

### Module Definition (code, not stored)

| Field | Type | Rules |
|---|---|---|
| `id` | string | `^[a-z][a-z0-9]{1,23}$`, unique in the app |
| `version` | string | semver `x.y.z` |
| `dependencies` | map id → range | ranges `x.y.z`, `^`, `~`, `>=`; self-dependency is an error |
| `access` | Access Declaration | see below; defaults to own types only, `bound` Spaces, no `manage` |
| `provides` | types, views, features, transports, identityProviders | names namespaced by `id` |
| `activate`, `deactivate` | functions | optional |

Relationships: depends on 0..n Modules; owns 0..n Object Type Schemas, Views, Features; may provide Transports and Identity Providers.

### Access Declaration

| Field | Rules |
|---|---|
| `types.read`, `types.write` | full type names; `write` ⊇ `read`; names must be well-formed (`module.name`); the module's own types are implicit |
| `spaces.read`, `spaces.write` | `any` or `bound`; `write: 'any'` requires `read: 'any'` |
| `spaces.manage` | boolean, default false |

The effective declaration is computed at resolve time and reported before any module code runs.

### Object Type Schema

| Field | Rules |
|---|---|
| `type` | `<moduleId>.<name>`; name matches `^[a-z][A-Za-z0-9_]{0,31}$` |
| `versions[]` | ascending, contiguous from 1; each has the complete `fields` list |
| `fields[name]` | FieldDef; a name has one `type` across all versions |
| `up` | required for version > 1; pure, idempotent, clock-aware |
| `down` / `breaking` | one of them required for version > 1 |
| `merge.editResurrects` | boolean, type-level; registered with the core (C-1) |

Registered type = (schema, owning module, latest version). Registry key is `type`; a duplicate key fails the later module (see transitions).

### View

Custom element `<moduleId>-<name>` defined from a `ViewFactory(ctx)`. The defined class is a host wrapper subclass: lifecycle callbacks guarded, `ctx` getter injected.

### Feature

`<moduleId>.<id>`; `singleton` (default true). Holds a start handle (unsubscribe/stop function) while running. Counters: consecutive failures (stop at 5).

### App Config

See [contracts/app-config.ts](./contracts/app-config.ts). Build-time input, also embedded in the bundle (minus build-only fields) for `startApp`.

### Runtime Manifest

See [contracts/runtime-manifest.md](./contracts/runtime-manifest.md). Fetched at start, cached.

### Device-local state (not synced, not application data)

| Item | Where | Notes |
|---|---|---|
| Space bindings (module → Space, mode) | IndexedDB `sync-modules` store `bindings` | A device setting about which Spaces a module may touch on this device. Not shared with peers. Principle II: this is configuration of the local runtime, not synced app data. |
| Runtime manifest + module files | Cache Storage `sync-modules-v1` | Loader-owned |
| Shell | Cache Storage `shell-<hash>` | Service-worker-owned |
| Module-local settings that must sync | Syncable Objects of the module's own types | Never a side store |

## Module state machine

```text
                 ┌────────────── (runtime only) ──────────────┐
                 │ refused  (origin, scheme, id-clash,          │
 listed ─► resolved ─► active ─┬─► (stop) ─► stopped           │
   │          │                └─► stale (active from cache)   │
   │          ├─► skipped  (dependency missing/failed/unsatisfied)
   │          └─► failed   (id/name rule, collision, cycle member,
   │                         activate threw or timed out → rolled back)
   └─► unavailable (runtime: unreachable and no cache)
```

Transitions and rules:

1. **resolved**: definition parsed, names valid, no collision with a module earlier in order. A collision (same type or element name, same ID) fails the *later* module deterministically (dependency order, then ID) and names both.
2. **active**: `activate` completed (or none) and all declared registrations committed atomically: schemas into the registry and validator, `registerType` into the core, elements defined, features started, transports added. Any throw before the commit rolls back everything for that module.
3. **skipped**: a dependency is absent, `failed`, `skipped`, `unavailable`, or its single registered version does not satisfy the range.
4. **failed** modules never block siblings; a cycle fails only its members.
5. **stale**: a runtime module running from a cached copy because the network copy was unavailable or failed integrity.
6. A runtime module can move `unavailable → active` later in the same session if a retry succeeds (its elements are then defined and existing markup upgrades).

## Schema version / object lifecycle

```text
Object fields as stored (per-field LWW, 001)
   v1 packets:  { title, done }            ── schemaVersion 1
   v2 packets:  { name, done, priority }   ── schemaVersion 2 (+ mirror { title } if `down`)

project() for a v2 module: up(v1 -> v2) = rename(title -> name) + addDefault(priority, 0)
   both title and name set  → newer clock wins
   object.schemaVersion (core) = max seen; projection never writes
```

State of a packet at a receiver:

```text
received ─► validated ─┬─ accept ─► applied (001 merge)
                       ├─ defer   ─► parked ─► revalidate() ─► accept | reject
                       └─ reject  ─► discarded + reported
```

`defer` applies only to unknown types inside the boot window.

## Validation rules (summary of FR-005/FR-006)

| Rule | Where |
|---|---|
| Local write validated before a packet exists | data facade → `send` phase of the validator |
| Incoming packet validated before apply | `apply` phase |
| Pure function of body and schema | `validateBody` |
| Newer version accepted leniently, unknown fields kept | `k > latest` |
| Older version validated against its own field list | `k ≤ latest` |
| Defaults filled by the writer only | `prepareWrite` |

## Events and reports

`host.report()` and `HostEvent` (see [contracts/module-api.ts](./contracts/module-api.ts)) are the observable state for developers: every module's status and reason, declared access, registrations, denials, view and feature errors, schema violations, refused runtime entries.
