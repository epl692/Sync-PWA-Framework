# Research: Modules & App Assembly

All open items from the Technical Context are resolved here. Each entry gives the decision, rationale, and alternatives. "Review of 001/002" items are facts found in the built code that change the design.

## R-01: Build tooling is esbuild, with a small owned build package

- **Decision**: New Node-only package `@sync/app-build` drives **esbuild** (already the repo's bundler in `scripts/build.mjs` and the e2e static-hosting test). `buildApp(config)` bundles a generated entry (`app.config` + `@sync/modules` runtime), content-hashes outputs, emits `index.html`, `manifest.webmanifest`, `sw.js` with an embedded precache list, and optionally the runtime module manifest. `buildModule(entry)` bundles one module into a single-file ESM for runtime loading.
- **Rationale**: Zero new bundler dependency. The output is plain files (Principle VII). The spec leaves the choice to this plan.
- **Alternatives**: Vite (nice dev server and plugin ecosystem, but pulls Rollup and a large dependency tree and adds a second bundler beside esbuild); Webpack (heavy); no bundler (cannot satisfy "list modules in a config, build"). A Vite plugin wrapper can be added later without changing the module contract.

## R-02: A module is a declarative definition plus an optional activation hook

- **Decision**: `defineModule({ id, version, dependencies, access, provides, activate? })`. What a module registers (object types, views, features, transports, identity providers) is **declared as data in `provides`**, not registered imperatively. The host reads the definition and validates it (names, collisions, dependencies, access) before running any module code.
- **Rationale**: FR-001 wants the registrations listed; US5-2 wants declared access visible to the App Developer; FR-002/US1-3 want collisions found at startup with a clear error. All three need to inspect a module without executing it. Declarative definitions also make registration transactional (R-05).
- **Rules**: Module ID matches `^[a-z][a-z0-9]{1,23}$` (no hyphen, so it can prefix element names). Type names are `<id>.<name>`. Custom elements are `<id>-<name>`. Both prefixes are checked by the host, so a module cannot register outside its namespace; two modules colliding means a duplicate ID, which is a registration error naming both.
- **Alternatives**: Imperative `register(registry)` only (cannot be inspected, partial registration on throw); manifest JSON next to code (two sources of truth).

## R-03: Everything a module needs arrives through its context, never through imports

- **Decision**: Module code imports only **types** from `@sync/modules` (erased at build). Runtime values come through `ModuleContext`: the access-scoped data facade, `ui.LiveElement` (base class for views), logging, and settings. Views are declared as **factories** `(ctx) => class extends ctx.ui.LiveElement {...}`.
- **Rationale**: A runtime-loaded module is a self-contained file with no bare imports (R-08). If modules imported helpers, bundled and runtime modules would differ, breaking FR-009 ("same contract"). It also keeps `@sync/core` out of module code, which is what access enforcement relies on (R-10).
- **Alternatives**: Import maps (extra moving part, no support for blob-loaded modules); each module bundles its own helpers (duplicate code, and the facade would not be host-controlled).

## R-04: Schemas are plain data with explicit versions, validated by a pure function

- **Decision**: `ObjectTypeDef { name, versions: SchemaVersion[], merge? }`. A `SchemaVersion` has `version`, `fields`, and (for `version > 1`) `up`; it may have `down`. Fields use a small built-in type set: `string`, `number`, `integer`, `boolean`, `timestamp`, `enum`, `ref`, `json`, `list` (list of primitives, replaced whole under LWW), each with `required`, `default`, and type-specific constraints (`min`, `max`, `maxLength`, `pattern`, `values`, `maxBytes`), plus an optional pure `check(value) => string | undefined`. No validation library.
- **Validation is a pure function of (packet body, schema)**. It never reads the clock, existing state or other objects. Required fields are enforced on `create` only; an update may not `UNSET` a required field. Cross-field rules (`objectCheck`) apply to `create`, which carries the full field set.
- **Rationale**: Convergence (Principle III). A verdict that depended on local state would let peers disagree about which packets were applied. With a pure check, two peers on the same schema versions always agree, and a rejection never depends on arrival order.
- **Alternatives**: JSON Schema (large, dependency, does not model merge/versions); zod/valibot (runtime dependency inside the core path; lacks migrations/merge options); rules reading existing state (non-convergent).

## R-05: Registration is transactional and failures are isolated

- **Decision**: Three phases. **Resolve** (pure): parse definitions, check names/prefixes/collisions, resolve dependencies, topologically sort. **Boot core**: pick the identity provider and transports from resolved definitions, open the core (`openSecureCore`). **Activate** (per module, in order): build the scoped context, run `activate`, then commit that module's declared registrations (schemas into the validator, resurrect flags into the core, element definitions, features) only if it did not throw. A throw or timeout (default 5 s) rolls back that module; it and its dependents get status `failed` or `skipped`, and every other module continues. A dependency cycle fails only the members of the cycle.
- **View errors** (FR-003): the host defines each element via a wrapper subclass whose lifecycle callbacks (`connectedCallback`, `disconnectedCallback`, `attributeChangedCallback`, `adoptedCallback`) run in try/catch, replacing the element with an error placeholder. `LiveElement.render` is also wrapped. **Feature errors**: handler exceptions are caught and counted; five consecutive failures stop that feature and report it.
- **Alternatives**: One-phase imperative registration (partial state on failure); try/catch only at the top level (one bad view would still break its page).

## R-06: Shared-module versions resolve to one instance

- **Decision**: A module ID has exactly one active version per app. Dependencies are semver ranges (`exact`, `^`, `~`, `>=`, with a small owned parser, about 80 lines). If the single registered version of a shared module does not satisfy a dependent's range, **the dependent** fails with `unsatisfied-dependency`; the shared module and all others keep working. The same ID twice is a build-time error (bundled) or a refused entry (runtime, bundled wins).
- **Rationale**: Types and element names are global per module ID, so two copies cannot coexist. This resolves the "two modules depend on different versions" edge case deterministically.
- **Alternatives**: Multiple instances per ID (would need per-instance namespaces and break FR-002); the `semver` package (runtime dependency for a tiny need).

## R-07: Mixed schema versions: read-time migration, additive writes, lenient on newer

Review of 001: the object's fields are a per-field LWW join, and `schemaVersion` is just the maximum seen. That already gives the properties needed; no packet is ever rewritten.

- **Validate by packet version.** A packet with `schemaVersion = k ≤ latest` is validated against version `k`'s field list (so a v2 peer still accepts v1 packets that use v1 field names). A packet with `k > latest known` cannot be fully validated: the peer **accepts** it, type-checks the fields it knows by name, and passes unknown fields through. Unknown fields are stored and relayed and never dropped, so a v1 peer loses nothing (US6-2).
- **Field names never change type across versions.** The schema lint (`checkSchema`) fails a `versions` array where the same field name changes type. A different shape needs a new field name plus a migration. This keeps "lenient on newer" safe, because a known field always means the same kind of value.
- **Migrate on read, clock-aware.** The view an app sees is `project(object)`: run `up` for each version step from the object's oldest present fields up to `latest`. `up` receives the fields and their clocks (core amendment C-2) and returns the new-version fields, and helpers `rename`, `addDefault`, `convert` pick the newer of old and new by clock. Since a peer's merged state converges, every peer on the same versions computes the same projection (US6-1, US6-3, SC-004).
- **Writes are additive.** A v2 edit writes v2 field names only, in a packet with `schemaVersion = 2`. If the version defines `down`, the host also mirrors the change into the previous version's fields in the same packet, so v1 peers keep seeing it. Without `down`, v1 peers still sync, store and relay it but do not see changes to the renamed fields until they upgrade. Mirroring is on by default when `down` exists (`compatWrite` can narrow it).
- **Irreversible migrations** (edge case): a migration that cannot have a `down` is declared `breaking: true`. The host still converges and loses nothing; it logs that v1 peers lose visibility of those fields, and the lint requires `breaking` to be explicit.
- **Rationale**: Per-field LWW means a v1 peer that edits only v1 fields cannot clobber v2 fields (an update packet carries only changed fields). Read-time migration needs no coordination, no flag day, and no packet rewrite.
- **Alternatives**: Eager migration that writes migrated packets (races with v1 peers and breaks them); rejecting newer-version packets (v1 peers would stop syncing, violating US6-2); defer-until-upgrade (parked limit, see R-09).
- **Cost**: Legacy field names stay in stored objects forever (hidden from the projection). Compaction does not remove them. Acceptable for v1; a `retire` step is a later optimization.

## R-08: Runtime modules are fetched, verified, cached by the loader, and imported from a blob

- **Manifest**: `modules/manifest.json` = `{ v: 1, modules: [{ id, version, url, integrity?, dependencies? }] }` (see [contracts/runtime-manifest.md](./contracts/runtime-manifest.md)). Resolved relative to the manifest URL.
- **Same origin (FR-010)**: Each `url` is resolved to an absolute URL and refused unless `origin` equals `location.origin` and the scheme is http(s). Fetches use `redirect: 'error'`, and `response.url`'s origin is checked again. A refused entry is logged and reported (`module:refused`), never fatal. A runtime entry whose ID matches a bundled module is refused (bundled wins), so a manifest can not replace shipped code.
- **Load**: `fetch` the file, verify `integrity` (SHA-256, via Web Crypto) when present, store the verified response in Cache Storage (`sync-modules-v1`, keyed by URL), then `import()` a `blob:` URL made from the exact verified bytes. The module is a single-file ESM bundle with no relative or bare imports (enforced by `buildModule`). Because the loader owns this cache, FR-011 does not depend on the service worker, and what runs is exactly what was verified.
- **Offline / failure (US4-3)**: if the fetch fails, use the cached copy (any version; status `stale`) and report `module:stale`. No cache → the app starts without it and reports `module:unavailable`. An integrity mismatch refuses that response and falls back to the previous cached copy.
- **Boot does not wait for the network (Principle I)**: bundled modules activate first and the UI is usable. The manifest is fetched with a short timeout (default 2500 ms), falling back to the cached manifest. Runtime modules register as they arrive; views for them upgrade in place when their elements are defined.
- **Updates while open (edge case)**: custom elements cannot be redefined, so a running app never hot-swaps a module. A background manifest re-check (on `online` and `visibilitychange`) caches the newer file and emits `module:update-available`; it takes effect at next launch or when the app calls `host.reload()`. Other open tabs on older versions stay compatible via R-07.
- **CSP note**: blob loading needs `script-src 'self' blob:`; the generated `index.html` ships that policy and the docs call it out.
- **Alternatives**: `import(url)` directly (the browser follows redirects and the verified bytes are not the executed bytes; caching then depends on the service worker); `<script>` injection (same problems, global scope); iframes/workers as sandbox (heavy and out of scope per the Assumptions); Module Federation (build-time coupling).

## R-09: Unknown types, and a finding about parked packets

Review of 001: `defer` parks a packet (kept, relayed, not applied), but parked packets count toward `limits.maxParkedPerAuthor` (default 1000), and **packets over that limit are rejected, meaning dropped** (`apply.ts`, `parked-limit`). Deferring a type whose module never loads would eventually drop data.

- **Decision**: The schema validator defers an unknown, non-`$` type **only during the boot window** (until every module listed in the config and manifest is registered or has failed, bounded by a timeout, default 10 s), then the host calls `core.revalidate()`. After the window an unknown type is **accepted as opaque**: stored, relayed, not rendered (the "module removed" edge case keeps data). When the module appears later, the objects are projected with field checks (below).
- **Read-time field check**: the projection omits a field whose stored value fails the current schema and reports `violation` events. This is the backstop for opaque data that arrived before its schema existed.
- **Types starting with `$`** belong to spec 002 and are accepted by this validator without inspection.
- **Alternatives**: Defer forever (silently drops data past 1000 per author); accept unknown immediately (data from not-yet-loaded runtime modules would skip validation, the common case at every cold start).

## R-10: Access declarations are enforced by a facade, plus build-time import checks

- **Declaration**: `access: { types: { read: string[], write: string[] }, spaces: { read: 'any' | 'bound', write: 'any' | 'bound', manage?: boolean } }`. A module's own types are implicitly readable and writable but still listed to the App Developer. `write` implies `read`. `bound` means only Spaces the app binds to that module at runtime (`host.bindSpace(moduleId, spaceId, 'r'|'rw')`); `any` means any Space the user is in. `manage` (default false) hands the module the full Spaces API (create, invite, remove); otherwise it sees only a read-only `list()`. Modules never receive keys, signer or keystore (002 R-03).
- **Enforcement (FR-012)**: A module gets only `ctx.data`, a facade over the core with the same method names. Each call checks type and Space; `query` requires `type` (or `id`, checked after load). `update`/`remove` load the object to learn its type; a missing object and an undeclared type produce the **same** `AccessDeniedError`, so the facade is not an existence oracle. Denials emit `access:denied` to the host for developers.
- **Static visibility (US5-2)**: `host.report()` returns every module's declared access, status, and registrations.
- **Defense in depth, not a sandbox (Assumption)**: same-origin code could import `@sync/core` or open IndexedDB. `buildModule` and `buildApp` fail when module source imports `@sync/core`, `@sync/spaces` or other `@sync/*` internals (checked on the esbuild metafile), and `eslint` carries a matching `no-restricted-imports` rule for module packages. Runtime modules are same-origin and chosen by the App Developer, which is the trust boundary the spec accepts.
- **Alternatives**: Proxy the real core object (leaks more than it blocks); run modules in Workers or iframes (rejected by the Assumptions and by the cost to Web Component views); a capability token system (more machinery than same-origin trust justifies).

## R-11: Views are plain custom elements; a small optional base class does the binding

- **Decision**: A view is any `HTMLElement` subclass. The host provides `ctx.ui.LiveElement`, a thin base class with `bind(querySpec, render)`: it subscribes in `connectedCallback`, unsubscribes in `disconnectedCallback`, coalesces updates to one render per frame, and wraps rendering in the error boundary. Shadow DOM and internal frameworks are allowed (Technical Constraints). `ctx` is made available on instances by the host's wrapper subclass (a prototype getter), since the browser constructs elements without arguments.
- **Pages / routing**: not in the Framework core (Principle VI: core stays small, FR-001 lists no routes). Views are placed with ordinary HTML in the app's `index.html` or by app code; custom elements upgrade whenever they are defined. The sample app uses a ~20 line hash switcher written in the app, not a framework feature.
- **Alternatives**: Require a base class (blocks framework-based views); expose the core to elements (breaks access enforcement).

## R-12: Features can be singleton per device with Web Locks

- **Decision**: `FeatureDef { id, singleton?, start(ctx), stop? }` (default `singleton: true`). Singleton features run in one tab per origin using `navigator.locks.request('sync-feature:<module>.<id>', ...)`; other tabs wait and take over when the holder closes. Features that are cheap and idempotent may set `singleton: false`. Without Web Locks the feature runs in every tab and reports a warning.
- **Rationale**: A reminder or derived-object feature would otherwise fire once per open tab. Features run in the page, not the service worker; background execution is out of scope.
- **Alternatives**: Run only in a SharedWorker or service worker (patchy support, harder debugging); no coordination (duplicate side effects).

## R-13: Transports and identity providers are modules, but providers need boot-time registration

- **Decision**: `provides.transports` entries are `{ id, create(ctx) => Transport }`; the host calls `core.addTransport` after activation, so they can be bundled or runtime. `provides.identityProviders` entries are `{ id, create(ctx) => IdentityProvider }`; the provider is needed to open the secure core, so providers must be available in the boot phase: bundled modules, or runtime modules the manifest marks `"boot": true` (fetched before the core opens). A provider arriving after boot is refused with `provider-after-boot`. The app config selects which transports and provider are active by ID.
- **Rationale**: Spec 002 `installSpaces` takes the provider in its config, so it must exist first. Transports can join at any time.
- **Alternatives**: Allow provider hot-swap (spec 002 R-13 allows swapping at build, not at runtime, and the keystore binds to it).

## R-14: PWA packaging is generated, hand-written service worker, own installability check

- **Output**: `index.html`, content-hashed `app.[hash].js/css`, `manifest.webmanifest`, `sw.js`, icons (192, 512, maskable from the config), optional `modules/` and `modules/manifest.json`. All URLs are relative and `start_url`/`scope` come from `base`, so the app deploys at a domain root or a subpath on any static host. Routing is a single `index.html` entry with no server rewrites needed.
- **Service worker** (generated, about 120 lines, no Workbox): precache the build outputs listed with their hashes; cache-first for precached URLs; navigation requests answered with the cached `index.html`; `modules/` and the relay/transport traffic pass through untouched (the loader owns its cache, R-08); old caches are deleted on activate. A new worker installs in the background and waits; the app receives `app:update-ready` and may call `host.applyUpdate()` (which sends `skipWaiting` and reloads). Default is "next launch", never a mid-session swap.
- **Offline from first launch after install (US3-2)**: install waits for the full precache before the worker activates, and `host.start()` resolves `app:offline-ready` after that. Bundled modules are part of the precache, so shell and modules load offline.
- **Installability audit (SC-001)**: Lighthouse removed its PWA category, so the audit is (1) a static check `verifyInstallable(outDir)` (manifest name, `start_url`, `display`, 192/512 icons, service worker with `fetch` handler, secure origin) and (2) in Playwright/Chromium, the DevTools protocol `Page.getInstallabilityErrors` must be empty against the plain static host.
- **Security / storage**: the shell calls `navigator.storage.persist()` once after install (best effort) so the local store is not evicted.
- **Alternatives**: Workbox (runtime dependency inside the worker, large generic surface); `vite-plugin-pwa` (tied to Vite); no service worker (fails US3-2).

## R-15: Dependencies justified

| Package | Dependency | Justification |
|---|---|---|
| `@sync/modules` | none at runtime | Semver, schema validation and facade are small and owned |
| `@sync/app-build` | `esbuild` (regular dependency, Node tooling only, never shipped to browsers) | Already the repo's bundler |
| tests | `jsdom` (dev) | Custom element unit tests without a browser. Real behavior is covered in Playwright |
| tests | existing `vitest`, `fast-check`, `fake-indexeddb`, `@playwright/test` | No change |

## R-16: Review of 001/002 that changes this plan

1. `resurrectingTypes` is a fixed `Set` read from `Config` at core creation. Module schemas register after the core exists (and runtime modules much later), so the core needs a mutable registry. **Amendment C-1.**
2. `SyncableObject` exposes plain values only, but clock-aware migration (R-07) needs per-field clocks. **Amendment C-2**, additive and opt-in.
3. `defer` counts toward `maxParkedPerAuthor` and overflow is rejected, so "defer unknown types" is not safe for long (R-09).
4. The 001 send-phase validator already throws `PacketRejectedError` to the caller, which gives US2-1 (local refusal) without core change; the facade maps it to a typed `SchemaValidationError`.
5. The 001 validators receive `existing` only after decode in the apply phase. This feature's validator never uses it (pure checks, R-04), so it is unaffected by that restriction.
6. Spaces have no "kind" (002 `SpaceInfo` is id, name, role), so access declarations can only say `any` or `bound`, not "a notes Space". `bound` plus a host call is the smallest mechanism that meets FR-012.
7. 002 `openSecureCore` wires the codec, signer and snapshot guard; this feature's `startApp` calls it and refuses a plaintext test codec when building for production (`assertSecureCore`).

## Changes made during implementation

Decisions above that changed once the code existed (reasons in [validation.md](./validation.md#deviations-from-the-plan)):

- **R-08 (cache)**: the loader finds a cached module by id as well as by URL, and tidies the cache only after the manifest's modules have been loaded (an older copy stays as the fallback until the listed version is cached).
- **R-08 (boot)**: waiting for the manifest on a first launch is opt-in (`runtime.waitForBoot`); otherwise bundled modules never wait.
- **R-07**: updates declare their schema version (core amendment C-3); the migration helpers live at `@sync/modules/migrate` so runtime modules can use them; `Derived` values carry the clock of their source through a chain of migrations.
- **R-10**: denials for a missing object, an undeclared type and an unbound Space are one uniform error; the host event carries the detail. The host is not published on `window` in production builds.
