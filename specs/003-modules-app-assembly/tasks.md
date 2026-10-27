---

description: "Task list for Modules & App Assembly (003-modules-app-assembly)"
---

# Tasks: Modules & App Assembly

**Input**: Design documents from `/specs/003-modules-app-assembly/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md). Specs 001 and 002 are implemented and their suites are green.

**Tests**: INCLUDED and written first. Constitution Principle VIII requires test-first work, a contract suite for the Module contract, and property-based convergence tests. Within each phase, run the test tasks and confirm they FAIL before starting the implementation tasks.

**Organization**: Tasks are grouped by user story. Story order follows priority (P1: US1, US2, US3; P2: US4, US5; P3: US6). US2 builds on the registry from Phase 2 and can run in parallel with US1 once Phase 2 is done. US4 needs the host from US1 and the validator wiring from US2. US6 extends the schema code from US2.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an unfinished task)
- **[Story]**: US1 to US6, matching the stories in spec.md
- Paths follow plan.md. Folders `definition`, `schema`, `validator`, `host`, `access`, `ui`, `features`, `loader`, `app` are under `packages/modules/src/`. Tests are under `packages/modules/tests/{unit,property,contract,integration}/`.
- Contract files (`specs/003-modules-app-assembly/contracts/*.ts`) are the source of truth for exported names and signatures; copy types from them into the package rather than redesigning.

---

## Phase 1: Setup (Shared Infrastructure)

- [X] T001 Scaffold `packages/modules` (`@sync/modules`) with `package.json` (same shape as `packages/spaces/package.json`: `main`/`types`/`exports` to `./src/index.ts`, `@sync/core` and `@sync/spaces` as peerDependencies, NO runtime `dependencies`), `tsconfig.json` and an empty `src/index.ts`
- [X] T002 [P] Scaffold `packages/app-build` (`@sync/app-build`) with `package.json` (regular dependency `esbuild` only; `bin` entry `sync-check-modules` pointing at `src/cli.ts`), `tsconfig.json` and an empty `src/index.ts`
- [X] T003 [P] Scaffold workspace `packages/sample-app` (`@sync/sample-app`, private) with `package.json` scripts `build` (`tsx ../app-build/src/cli.ts build app.config.ts dist`) and `build:runtime`, `tsconfig.json`, and folders `modules/`, `runtime-modules/`, `public/icons/`
- [X] T004 [P] Add `@sync/modules` and `@sync/app-build` to `paths` in `tsconfig.base.json` and add root npm scripts `test:modules` (`vitest run packages/modules`) and `test:mixed-versions` (`vitest run packages/modules/tests/property/mixed-versions`) in `package.json`; in `scripts/build.mjs` build `app-build` with `platform: 'node'` (as already done for `relay-server`) and add `esbuild` to the `external` list, so it is not bundled for the browser, and confirm `@sync/sample-app` (no `src/index.ts`) is skipped, so `npm run build` still passes
- [X] T005 [P] Add `jsdom` to root `devDependencies` and document in `packages/modules/tests/README.md` that DOM tests start with `// @vitest-environment jsdom`
- [X] T006 [P] Release-surface guard test in `packages/modules/tests/unit/release-surface.test.ts`: `@sync/modules` has zero runtime `dependencies`, `@sync/app-build` depends only on `esbuild`, and no file under `packages/modules/src/` imports `@sync/testkit`
- [X] T007 [P] Add an `eslint.config.js` block for `packages/sample-app/modules/**` and `packages/sample-app/runtime-modules/**` with `no-restricted-imports` banning `@sync/core`, `@sync/spaces`, `@sync/identity-invite`, `@sync/transport-*`, `@sync/relay-server` and `@sync/testkit` (modules may import only types from `@sync/modules`; research R-10)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core amendments C-1 and C-2, module definition rules, the schema registry and lint, and a basic projection. Every story needs these.

**CRITICAL**: No user story work starts until this phase is complete

### 2a. Core amendments (tests first)

See [contracts/core-amendments.md](./contracts/core-amendments.md).

- [X] T008 [P] C-1 test in `packages/core/tests/integration/amendments/register-type.test.ts`: after queries exist, `registerType('m.t', {resurrects: true})` makes a deleted-then-edited object visible and `undo` of a delete stops throwing `NotUndoable`; `unregisterType` reverses it; registering a `$`-prefixed type throws; live queries re-emit when visibility changes
- [X] T009 [P] C-2 test in `packages/core/tests/integration/amendments/with-clocks.test.ts`: `get(id, {withClocks: true})` and `query({withClocks: true})` return `clocks` equal to the HLC strings reported by `history()`; default results have no `clocks` key
- [X] T010 [P] C-1 property test in `packages/core/tests/property/register-type-order.test.ts`: two cores given the same packets and calling `registerType` in different orders and at different times have equal `stateHash`

### 2b. Core amendments (implementation)

- [X] T011 C-1: add `registerType(type, {resurrects?})` and `unregisterType(type)` to `SyncCore`; make `ResolvedConfig.resurrectingTypes` the mutable backing set seeded from `Config.resurrectingTypes`; re-emit affected live queries; edit `packages/core/src/types.ts`, `packages/core/src/core.ts`, `packages/core/src/query/engine.ts`
- [X] T012 [P] C-2: add `SyncableObject.clocks?`, `QuerySpec.withClocks?` and `get(id, {withClocks})`; populate `clocks` from stored per-field clocks only when requested; edit `packages/core/src/store/objects.ts`, `packages/core/src/query/engine.ts`, `packages/core/src/core.ts`, `packages/core/src/types.ts`
- [X] T013 Update `specs/001-sync-core/contracts/public-api.ts` with `registerType`, `unregisterType`, `withClocks` and `clocks`, then run `npm run test` and `npm run test:contract` and confirm gate S0 passes (T008 to T010 green, all 001 and 002 tests unchanged)

### 2c. Module definition and schema registry (tests first)

- [X] T014 [P] Test semver parsing and range matching (`x.y.z`, `^`, `~`, `>=`; invalid input throws) in `packages/modules/tests/unit/semver.test.ts`
- [X] T015 [P] Test definition rules in `packages/modules/tests/unit/definition.test.ts`: module ID must match `^[a-z][a-z0-9]{1,23}$`; version is semver; types must be named `<id>.<name>` with name matching `^[a-z][A-Za-z0-9_]{0,31}$` and may not start with `$`; element names must be `<id>-<name>`; a self-dependency is an error; each error names the module and the offending value
- [X] T016 [P] Test access normalization in `packages/modules/tests/unit/access-normalize.test.ts`: own types are implicitly readable and writable and still reported; `write` implies `read`; `spaces.write: 'any'` requires `spaces.read: 'any'`; defaults are `bound`, no `manage`
- [X] T017 [P] Test `checkSchema` and the registry in `packages/modules/tests/unit/schema-lint.test.ts`: versions non-empty, ascending, contiguous from 1; version > 1 needs `up`; version > 1 needs `down` or `breaking: true`; a field name keeps one `type` across versions; `enum` has at least one value; `pattern` compiles; `default` satisfies its own field; names match `^[a-z][A-Za-z0-9_]{0,31}$`; `compatWrite` within `[1, latest]`; duplicate type registration throws naming both modules. The check that a `down` emits only declared names is NOT here; it is T097 and T104

### 2d. Module definition and schema registry (implementation)

- [X] T018 [P] Implement the semver parser and range matcher (no dependency) in `packages/modules/src/definition/semver.ts`
- [X] T019 [P] Implement `defineModule` (identity function with types) and `validateDefinition(def)` returning a list of problems for the rules in T015 in `packages/modules/src/definition/define.ts` and `packages/modules/src/definition/rules.ts`
- [X] T020 [P] Implement `normalizeAccess(def)` producing the effective declaration (the `ModuleReport['access']` shape in `contracts/module-api.ts`) in `packages/modules/src/definition/access.ts`
- [X] T021 [P] Copy the field and schema types from `contracts/schema.ts` into `packages/modules/src/schema/types.ts` (`FieldDef`, `SchemaVersion`, `ObjectTypeDef`, `ClockedFields`, `MergeOptions`, `RegisteredType`, `SchemaValidationError`)
- [X] T022 Implement `checkSchema(def)` per `contracts/schema-rules.md` §2, all rules except the `down` output-name check (T104), in `packages/modules/src/schema/lint.ts` (depends on T021)
- [X] T023 Implement `SchemaRegistry` (`register` runs `checkSchema` and throws on problems or a duplicate type, `unregister`, `get`, `list`) in `packages/modules/src/schema/registry.ts` (depends on T022)
- [X] T024 Implement the single-version `project(reg, obj)` (fields of the current version only, invalid stored values omitted and listed in `violations`, no migration yet) in `packages/modules/src/schema/project.ts` (depends on T021)
- [X] T025 Export the public surface (`defineModule`, types, `checkSchema`, `SchemaRegistry`, `project`) from `packages/modules/src/index.ts`

**Checkpoint**: Foundation ready. User story work can begin.

---

## Phase 3: User Story 1 - Build an App From Bundled Modules (Priority: P1)

**Goal**: An App Developer lists bundled modules in a config and gets a working app; modules register in dependency order, views bind to live queries, a collision fails with a clear error, and a failing module never stops the others.

**Independent Test**: Sample app with two bundled modules (`todo`, `stats`): both `active` in dependency order, `todo-list` renders and updates live, colliding names fail only the later module (quickstart S1, S7).

### Tests for User Story 1 (write first, must FAIL)

- [X] T026 [P] [US1] Host resolve test in `packages/modules/tests/unit/host-resolve.test.ts`: topological order; a missing dependency gives `skipped`; a dependency that failed gives `skipped` for its dependents only; an unsatisfied version range fails the dependent only; a cycle fails only its members; two modules with the same module ID or type or element name fail the later one (dependency order, then ID) with an error naming both
- [X] T027 [P] [US1] Activation test in `packages/modules/tests/unit/host-activate.test.ts`: registrations commit atomically after `activate` completes; a throw or a timeout (default 5000 ms, configurable) rolls back that module's schemas, `registerType` calls, elements, features and transports; the module becomes `failed` with a reason; siblings still activate
- [X] T028 [P] [US1] `LiveElement` test (`// @vitest-environment jsdom`) in `packages/modules/tests/unit/live-element.test.ts`: subscribes on connect and unsubscribes on disconnect; query changes trigger exactly one render per animation frame; an exception in `render` is contained and reported as `view:error`
- [X] T029 [P] [US1] Element wrapper test (jsdom) in `packages/modules/tests/unit/wrap-element.test.ts`: `connectedCallback`, `disconnectedCallback`, `attributeChangedCallback` and `adoptedCallback` errors are caught, the element shows an error placeholder, `view:error` is emitted and other elements keep working; `ctx` is available on instances through the injected prototype getter
- [X] T030 [P] [US1] Feature runner test in `packages/modules/tests/unit/feature-runner.test.ts`: a feature reacts to object changes without any view; `singleton` features take `navigator.locks.request('sync-feature:<module>.<id>')` (fake Web Locks) so only one runner is active; without Web Locks the feature runs and warns; five consecutive handler failures stop the feature and emit `feature:stopped`
- [X] T031 [P] [US1] Data facade test (own types only) in `packages/modules/tests/unit/facade-basic.test.ts`: `create`, `update`, `remove`, `get`, `query` and `undo` delegate to the core and return projected objects; `query` requires `type` or `id`
- [X] T032 [P] [US1] Boot test in `packages/modules/tests/integration/boot.test.ts` using `@sync/testkit` (secure core in memory): three phases run in order (resolve, open core with the selected identity provider and transports, activate); `startApp` refuses `security: 'plaintext-for-tests'` when `mode` is production; a provider module that fails leaves the app to report it
- [X] T033 [US1] Bundled integration test in `packages/modules/tests/integration/bundled.test.ts`: the sample `todo` and `stats` modules (from T044) activate in dependency order and a placed `todo-list` element renders and updates as objects change; a deliberately colliding module fails alone (depends on T044)

### Implementation for User Story 1

- [X] T034 [US1] Implement `resolveModules(defs)` (validate definitions, detect collisions, resolve dependency ranges, topological sort, cycle handling, per-module status and reason) in `packages/modules/src/host/resolve.ts`
- [X] T035 [US1] Implement the module event emitter and `host.report()` builder (`ModuleReport`, `HostEvent`) in `packages/modules/src/host/report.ts`
- [X] T036 [P] [US1] Implement `LiveElement` with `bind(spec, render)` (subscribe on connect, unsubscribe on disconnect, one render per animation frame via `requestAnimationFrame` with a microtask fallback, contained errors) in `packages/modules/src/ui/live-element.ts`
- [X] T037 [P] [US1] Implement `wrapElement(Ctor, ctx, report)` returning a subclass whose lifecycle callbacks are guarded, that injects `ctx` through a prototype getter and renders an error placeholder on failure, in `packages/modules/src/ui/wrap-element.ts`
- [X] T038 [P] [US1] Implement the feature runner (start/stop handles, Web Locks singleton with fallback warning, consecutive failure counter that stops at five) in `packages/modules/src/features/runner.ts`
- [X] T039 [US1] Implement the data facade for a module's own types (no declared cross-module access and no Space checks yet; Space and cross-module checks arrive in T089, so until then any Space the user is in is allowed) wrapping `SyncCore` and `project()` in `packages/modules/src/access/facade.ts`
- [X] T040 [US1] Implement `activateModule()` (build `ModuleContext`, run `activate` with timeout, stage then commit registrations atomically, roll back on failure) in `packages/modules/src/host/activate.ts` (depends on T034, T036 to T039)
- [X] T041 [US1] Implement `startApp(config)` and the `ModuleHost` object (resolve, open core via `openSecureCore` from `@sync/spaces`, select the identity provider and transports by ID, activate bundled modules in order, then call `config.onReady(host, spaces)`; `host.report()`, `host.on()`, `host.stop()`) in `packages/modules/src/app/start-app.ts` and `packages/modules/src/host/host.ts`
- [X] T042 [P] [US1] Implement `moduleContract()` and `fakeModuleHost()` in `packages/testkit/src/modules/index.ts` (checks: definition rules, `checkSchema`, clean activate/deactivate, undeclared-type denial once US5 lands, sibling isolation) and re-export from `packages/testkit/src/index.ts`
- [X] T043 [US1] Export `startApp`, `LiveElement` and host types from `packages/modules/src/index.ts`
- [X] T044 [P] [US1] Sample modules in `packages/sample-app/modules/todo/index.ts` (type `todo.item` v1 with fields `title` string required maxLength 200, `done` boolean default false; view `list` as `todo-list` with add/toggle/remove; view `editor`) and `packages/sample-app/modules/stats/index.ts` (depends on `todo@^1.0.0`; view `summary` as `stats-summary`; a feature counting open items)
- [X] T045 [US1] Sample `packages/sample-app/app.config.ts` and `packages/sample-app/index.template.html` placing `<todo-list>` and `<stats-summary>` with a ~20 line hash switcher written in the app, not the framework; its `onReady(host, spaces)` signs up when `spaces.session()` is undefined and creates a Space named "Personal" when `spaces.list()` is empty, so a first launch has a user and a Space to write to
- [X] T046 [US1] Run `moduleContract()` against both sample modules in `packages/sample-app/tests/modules.contract.test.ts` and confirm T026 to T033 pass

**Checkpoint**: US1 works on its own: bundled modules register, views bind, failures are isolated.

---

## Phase 4: User Story 2 - Declared Schemas Validate Data (Priority: P1)

**Goal**: Invalid writes are refused locally and by peers; "edit resurrects" works per type; newer-version packets are kept and relayed.

**Independent Test**: Valid and invalid objects written locally and injected as remote packets; only valid ones apply; 100% of violations refused (quickstart S2, SC-003).

### Tests for User Story 2 (write first, must FAIL)

- [X] T047 [P] [US2] `validateBody` table tests in `packages/modules/tests/unit/validate-body.test.ts` following `contracts/schema-rules.md` §1 exactly: bad version; `1 ≤ k ≤ L` uses the newest version ≤ k declaring each name; unknown field rejected; `k > L` is lenient (known names type-checked only, unknown pass); `create` requires `required` fields and runs `objectCheck`; `update` skips `required` but rejects `UNSET` on required; every field type and constraint (`maxLength`, `pattern`, `min`, `max`, `values`, `maxBytes` default 64 KiB, `maxItems` default 256); a throwing `check` rejects with `check-threw`
- [X] T048 [P] [US2] Oracle property test in `packages/modules/tests/property/validation.test.ts` (fast-check): generate valid and invalid bodies for random schemas and compare `validateBody` with an independent oracle written in the test; at least 10,000 runs; 100% agreement (SC-003); also assert purity (same input, same verdict, no dependence on time or call order)
- [X] T049 [P] [US2] Verdict mapping test in `packages/modules/tests/unit/schema-validator.test.ts` per the table in `contracts/schema-rules.md`: `$` types accepted; valid accepted; invalid rejected in `send` and `apply`; unknown type deferred while the boot window is open and accepted as opaque after `closeBootWindow()`
- [X] T050 [P] [US2] `prepareWrite` test in `packages/modules/tests/unit/prepare-write.test.ts`: defaults filled on `create` only; `schemaVersion` is the latest; no mutation of input
- [X] T051 [US2] Integration test in `packages/modules/tests/integration/schema-sync.test.ts` using two testkit cores: a local violating write throws `SchemaValidationError` and `history` is unchanged; an injected remote violating packet is rejected and not applied; a packet with a newer `schemaVersion` is stored and relayed to a third core; after `closeBootWindow()` plus `revalidate()` deferred packets for a late-registered type apply; and the removed-module edge case: after the module that owned `m.t` is dropped from the config and the host restarts, existing `m.t` objects are still in storage, `host.report()` lists no `m.t` registration, nothing renders them, and new `m.t` packets arriving after the boot window are accepted as opaque and kept
- [X] T052 [US2] Integration test in `packages/modules/tests/integration/resurrect.test.ts`: a type with `merge.editResurrects` restores the object on a concurrent delete and edit; a type without it stays deleted; `undo` of a delete works only for the former

### Implementation for User Story 2

- [X] T053 [P] [US2] Implement `validateBody(reg, body)` per `contracts/schema-rules.md` §1 (no clock, no I/O, no state) in `packages/modules/src/schema/validate.ts`
- [X] T054 [P] [US2] Implement `prepareWrite(reg, op, fields)` (defaults and latest `schemaVersion`; no mirroring yet) in `packages/modules/src/schema/prepare-write.ts`
- [X] T055 [US2] Implement `createSchemaValidator(registry)` (`PacketValidator` for phases `send` and `apply`, verdict mapping, `closeBootWindow()`) in `packages/modules/src/validator/schema-validator.ts` (depends on T053)
- [X] T056 [US2] In activation, register each type with the `SchemaRegistry` and the core (`core.registerType(type, {resurrects: merge.editResurrects})` from C-1), register the validator once at startup, close the boot window after all listed modules settle or after `bootWindowMs` (default 10000), then call `core.revalidate()`; edit `packages/modules/src/host/activate.ts` and `packages/modules/src/app/start-app.ts` (depends on T055)
- [X] T057 [US2] Make the data facade call `prepareWrite` before `create`/`update` and map the core's `PacketRejectedError` from the `send` phase to `SchemaValidationError`; edit `packages/modules/src/access/facade.ts`
- [X] T058 [US2] Emit `schema:violation` host events from projection when stored values fail the current schema (read-time check, research R-09); edit `packages/modules/src/schema/project.ts` and `packages/modules/src/access/facade.ts`

**Checkpoint**: US1 and US2 both work independently.

---

## Phase 5: User Story 3 - Deploy as a Static PWA (Priority: P1)

**Goal**: `buildApp` outputs plain static files that install as a PWA and work offline from first launch after install, at a domain root or a subpath.

**Independent Test**: Serve `dist` from a file-only server; installability errors empty; offline reload works (quickstart S3, SC-001).

### Tests for User Story 3 (write first, must FAIL)

- [X] T059 [P] [US3] `buildApp` test in `packages/app-build/tests/build-app.test.ts`: emits `index.html`, `app.[hash].js`, `manifest.webmanifest`, `sw.js`, icons; all URLs relative; hash changes when content changes; the CSP `connect-src` is `'self'` plus only the `connectSrc` origins; fails with every problem listed for: invalid module definition or schema lint failure, duplicate bundled module IDs, missing or wrong-size icons, `security: 'plaintext-for-tests'` in production mode
- [X] T060 [P] [US3] Service worker test in `packages/app-build/tests/sw-template.test.ts` running the generated `sw.js` in a fake service worker scope: install precaches every listed file and activation waits for it; a failed install leaves the old cache; activate deletes other `shell-*` caches and does not call `clients.claim()`; navigation requests get cached `index.html`; precached GETs are cache-first; `modules/*`, non-GET and cross-origin requests are untouched; `{type:'skipWaiting'}` message calls `skipWaiting()`
- [X] T061 [P] [US3] `verifyInstallable` test in `packages/app-build/tests/installable.test.ts`: passes on a good build; each missing member (name, `start_url`, `display`, 192 or 512 icon, SW registration, `fetch` listener, revision mismatch) is reported
- [X] T062 [P] [US3] App-runtime SW registration test (jsdom with a fake `navigator.serviceWorker`) in `packages/modules/tests/unit/sw-register.test.ts`: emits `app:offline-ready` after first activation and control; emits `app:update-ready` when a later worker waits; the exported `applyServiceWorkerUpdate()` posts `skipWaiting` to the waiting worker without reloading; registration failure reports `sw:unavailable` and the app continues
- [X] T063 [US3] E2E test in `tests/e2e/pwa-static.spec.ts`: build the sample app, serve it with a file-only Node server at the root and again under `/apps/sample/` (no rewrites, no API), assert `Page.getInstallabilityErrors` (CDP) is empty both times, wait for `app:offline-ready`, write an object, set the context offline, reload, and assert shell, both modules and the object load (depends on T067, T070)

### Implementation for User Story 3

- [X] T064 [US3] Implement `buildApp(opts)` (generate virtual entry from the config and `startApp`, esbuild bundle, content hashing, collect file revisions as SHA-256, `BuildError` listing all problems) in `packages/app-build/src/build-app.ts`
- [X] T065 [P] [US3] Emit `index.html` from `index.template.html` (viewport, theme-color, manifest link, CSP `default-src 'self'; script-src 'self' blob:; style-src 'self' 'unsafe-inline'; connect-src 'self' <config.connectSrc origins>; img-src 'self' data: blob:`, `<div id="app">`, module script) and `manifest.webmanifest` (`id` and `start_url` and `scope` `./`, `display` `standalone`, icons) in `packages/app-build/src/emit.ts`
- [X] T066 [P] [US3] Implement the generated service worker (about 120 lines, no Workbox) per `contracts/pwa-output.md` in `packages/app-build/src/sw-template.ts`
- [X] T067 [P] [US3] Implement `verifyInstallable(outDir)` in `packages/app-build/src/installable.ts`
- [X] T068 [US3] Implement the CLI (`build`, `check-modules`, `verify-installable <dir>`, which prints `ok` and exits 0, or prints each problem and exits 1) and `checkModules(configPath)` (resolve, `checkSchema`, collisions, no browser, exit code 1 on any problem) in `packages/app-build/src/cli.ts` and `packages/app-build/src/check-modules.ts`
- [X] T069 [US3] Implement service worker registration and the `app:offline-ready`, `app:update-ready`, `sw:unavailable` events, an `applyServiceWorkerUpdate()` helper (posts `skipWaiting` to the waiting worker; does not reload; until T081 a US3-only app exposes `host.applyUpdate()` as this helper followed by `location.reload()`), and a best-effort `navigator.storage.persist()` call after install, in `packages/modules/src/app/sw-register.ts`
- [X] T070 [US3] Add sample icons (`public/icons/icon-192.png`, `icon-512.png`, `maskable-512.png`) and make `npm run build -w @sync/sample-app` produce `packages/sample-app/dist`
- [X] T071 [US3] Export `buildApp`, `verifyInstallable`, `checkModules` from `packages/app-build/src/index.ts`

**Checkpoint**: All three P1 stories work. This is the MVP.

---

## Phase 6: User Story 4 - Add Modules at Runtime (Priority: P2)

**Goal**: Dropping a module file and updating the runtime manifest on the same host adds the module on next launch, cached for offline use; cross-origin entries are refused; failures never stop the app.

**Independent Test**: Add a module to the manifest, reload, offline reload (quickstart S4).

### Tests for User Story 4 (write first, must FAIL)

- [X] T072 [P] [US4] Manifest tests in `packages/modules/tests/unit/loader-manifest.test.ts` per `contracts/runtime-manifest.md`: `v` must be `1` (higher: load nothing new, keep cache, warn); malformed entry skipped while others load; refusal of other origin (`cross-origin`), non-http(s) scheme (`bad-scheme`), ID clash with a bundled module (`id-clash`); exported `id` and `version` must equal the entry (`malformed`); unknown extra fields ignored
- [X] T073 [P] [US4] Loader tests in `packages/modules/tests/unit/loader-load.test.ts` with fake `fetch`, `Cache` and `import`: fetch uses `redirect: 'error'` and the response URL origin is re-checked; `integrity` (SHA-256) must match or the response is refused and the previous cached copy is used (`stale`); network failure uses the cached copy of any version (`module:stale`); no cache gives `module:unavailable`; the file is imported from a blob URL of the exact verified bytes; an `import` statement inside the file is refused
- [X] T074 [P] [US4] Boot-order test in `packages/modules/tests/integration/runtime-boot.test.ts`: bundled modules activate before the manifest fetch resolves; the manifest fetch times out at `manifestTimeoutMs` (default 2500) and falls back to the cached manifest; runtime modules register as they arrive and their already-placed elements upgrade; `boot: true` entries load before the core opens; an identity provider from a non-boot entry is refused with `provider-after-boot`
- [X] T075 [P] [US4] Update-check test in `packages/modules/tests/unit/loader-update.test.ts`: a newer version in the manifest is fetched, verified and cached, `module:update-available` is emitted, and the running module is not replaced; the check runs on `online` and `visibilitychange`, at most once per 5 minutes; cached files no longer in the latest manifest are removed after a successful manifest load; `host.applyUpdate()` calls `applyModuleUpdates()`, then `applyServiceWorkerUpdate()`, then reloads, in that order
- [X] T076 [P] [US4] `buildModule` test in `packages/app-build/tests/build-module.test.ts`: output is a single ES module with no import statements (static or dynamic); a remaining import fails the build; returns `sha256-` integrity, `id` and `version`; `manifestEntry` is produced
- [X] T077 [US4] E2E test in `tests/e2e/runtime-modules.spec.ts` following quickstart S4: first online start loads, registers and caches `notes`; offline reload still loads it; a cross-origin entry is refused and logged; removing the file uses the cached copy (`module:stale`); a changed integrity refuses the new file and keeps the old; updating the manifest while open emits `module:update-available` and changes nothing until reload (depends on T084)

### Implementation for User Story 4

- [X] T078 [P] [US4] Implement manifest parsing, entry validation and the refusal rules in `packages/modules/src/loader/manifest.ts`
- [X] T079 [P] [US4] Implement the Cache Storage wrapper (`sync-modules-v1`, keyed by absolute URL, pruning) in `packages/modules/src/loader/cache.ts`
- [X] T080 [US4] Implement fetch, integrity check (Web Crypto SHA-256), cache write, blob-URL import and the `stale` and `unavailable` paths in `packages/modules/src/loader/load.ts` (depends on T078, T079)
- [X] T081 [US4] Integrate the loader with the host: late activation of runtime modules through the same `activateModule()`, `boot: true` handling before core open, `provider-after-boot` refusal, `revalidate()` after each runtime module registers, boot-window closing; edit `packages/modules/src/host/host.ts` and `packages/modules/src/app/start-app.ts`; compose `host.applyUpdate()` as `applyModuleUpdates()` (T082), then `applyServiceWorkerUpdate()` (T069), then `location.reload()` (depends on T069, T080, T082)
- [X] T082 [US4] Implement the update checker and `host.checkForUpdates()`, plus `applyModuleUpdates()` (switches the loader's active entries to the newly cached versions; does not reload), in `packages/modules/src/loader/update.ts`
- [X] T083 [P] [US4] Implement `buildModule(opts)` (esbuild single-file ESM, fail on any remaining import, return integrity/id/version) in `packages/app-build/src/build-module.ts` and export it
- [X] T084 [US4] Add the sample runtime module `packages/sample-app/runtime-modules/notes/index.ts` (type `notes.note`, view `notes-list`), make `build:runtime` write `dist/modules/notes.1.0.0.js` and `dist/modules/manifest.json` with integrity, and have `buildApp` copy a runtime `modules/` folder when present

**Checkpoint**: Runtime modules work on top of US1 to US3.

---

## Phase 7: User Story 5 - Modules Only Touch What They Declare (Priority: P2)

**Goal**: Access outside a module's declaration is denied; declarations are visible to the App Developer.

**Independent Test**: A module queries and writes an undeclared type and an unbound Space; both denied; report lists declarations (quickstart S5).

### Tests for User Story 5 (write first, must FAIL)

- [X] T085 [P] [US5] Enforcement matrix test in `packages/modules/tests/integration/access.test.ts`: own types always allowed; other module's type needs `types.read` or `types.write`; `write` implies `read`; `query` without `type` or `id` is denied; `update`/`remove` of a missing object and of an undeclared type throw the same `AccessDeniedError`; `spaces: 'bound'` modules can use only Spaces bound to them, `'any'` any joined Space; `spaces.admin` is present only with `manage: true`; the keystore, signer and raw core are never reachable from `ctx`; each denial emits `access:denied`
- [X] T086 [P] [US5] Binding store test in `packages/modules/tests/unit/bindings.test.ts` (fake-indexeddb): `bindSpace`/`unbindSpace` persist across host restarts, per module and per Space with mode `r` or `rw`, and are device-local (nothing is written as a Syncable Object)
- [X] T087 [P] [US5] Report test in `packages/modules/tests/unit/report-access.test.ts`: `host.report()` shows each module's declared access and registrations before and after activation, including skipped and failed modules
- [X] T088 [P] [US5] Banned-import test in `packages/app-build/tests/banned-imports.test.ts`: `buildApp` and `buildModule` fail when module source imports `@sync/core`, `@sync/spaces` or any other `@sync/*` internal (checked on the esbuild metafile), allowing type-only imports of `@sync/modules`

### Implementation for User Story 5

- [X] T089 [US5] Extend the facade with declared-type and Space checks, uniform `AccessDeniedError`, and `access:denied` events in `packages/modules/src/access/facade.ts` and `packages/modules/src/access/errors.ts`
- [X] T090 [P] [US5] Implement the device-local binding store (IndexedDB database `sync-modules`, store `bindings`) in `packages/modules/src/access/bindings.ts`
- [X] T091 [US5] Implement `host.bindSpace`/`unbindSpace` and `ctx.spaces` (`list(mode)`; `admin` only when `manage`) in `packages/modules/src/host/host.ts` and `packages/modules/src/access/spaces-facade.ts`; then extend the sample app's `onReady` (T045) to call `host.bindSpace('todo', personalSpaceId, 'rw')` and `host.bindSpace('stats', personalSpaceId, 'r')` so the sample keeps working under the default `bound` access, and re-run T046 and T063
- [X] T092 [P] [US5] Implement the metafile-based banned-import check shared by `buildApp` and `buildModule` in `packages/app-build/src/banned-imports.ts`
- [X] T093 [US5] Enable the undeclared-type denial check in `moduleContract()` in `packages/testkit/src/modules/index.ts`

**Checkpoint**: Access enforcement works with all earlier stories.

---

## Phase 8: User Story 6 - Evolve a Schema (Priority: P3)

**Goal**: v2 schemas migrate v1 objects at read time; v1 and v2 peers keep syncing and converge with no field loss.

**Independent Test**: Randomized mixed v1/v2 peers editing the same objects converge with no v1 field lost (quickstart S6, SC-004).

### Tests for User Story 6 (write first, must FAIL)

- [X] T094 [P] [US6] Migration helper tests in `packages/modules/tests/unit/migrate.test.ts`: `rename`, `convert`, `addDefault`, `all`; when both old and new are set the newer clock wins and a clock tie uses the string order of the clocks; helpers are idempotent
- [X] T095 [P] [US6] Multi-version `project()` tests in `packages/modules/tests/unit/project-versions.test.ts`: v1 object projected to v2 through `up`; v1 → v2 → v3 chain; legacy names stay stored and hidden; unknown (newer) fields are kept; invalid stored values omitted with `violations`
- [X] T096 [P] [US6] Mirroring tests in `packages/modules/tests/unit/prepare-write-mirror.test.ts`: with `down`, a v2 write also carries the previous version's names in the same packet (`schemaVersion` stays 2); `compatWrite` narrows how far back it mirrors; without `down` nothing is mirrored; a `down` emitting an undeclared name fails `checkSchema`; `breaking: true` emits `schema:breaking` once per session
- [X] T097 [P] [US6] Add the `down` lint cases to `packages/modules/tests/unit/schema-lint.test.ts` (extend T017): a `down` that emits a name not declared in the version it targets fails; a `down` that emits only declared names passes; `breaking: true` together with a `down` is allowed
- [X] T098 [US6] Mixed-version peer builder in `packages/testkit/src/modules/mixedVersions.ts` (two or more cores connected by the testkit memory transport, each with its own module version set; random edit, delete, partition and reconnect schedule)
- [X] T099 [US6] Property test in `packages/modules/tests/property/mixed-versions/convergence.test.ts` (fast-check, at least 1,000 runs, seed from `CONVERGENCE_SEED`): all peers' core `stateHash` equal; v2 projections identical across v2 peers; every v1 field value written by any peer is still stored on every peer; v1 peers keep all v2-written fields; with `down` defined, v1 peers also see v2 edits to renamed fields (depends on T098)
- [X] T100 [US6] Integration test in `packages/modules/tests/integration/mixed-version-sync.test.ts`: a v1 peer receives v2 packets, stores and relays them to a third peer, projects only fields it knows, and its own edits never overwrite v2 fields; a v2 peer receives v1 packets, validates them against v1's field list, applies, and projects through `up` (depends on T098)

### Implementation for User Story 6

- [X] T101 [P] [US6] Implement `migrate.rename`, `convert`, `addDefault`, `all` (clock-aware, idempotent) in `packages/modules/src/schema/migrate.ts`
- [X] T102 [US6] Extend `project()` to apply the `up` chain with `ClockedFields` built from `withClocks` reads (core amendment C-2), keep legacy names hidden, and validate the result against the latest version; edit `packages/modules/src/schema/project.ts` and make the facade request `withClocks` (depends on T101)
- [X] T103 [US6] Extend `prepareWrite` to compute `down` mirrors for L-1 down to `compatWrite` (default: current - 1 when the current version defines `down`, otherwise no mirroring) in `packages/modules/src/schema/prepare-write.ts`
- [X] T104 [US6] Extend `checkSchema` with the `down` output check (test-run each `down` over the version's declared field set; every emitted name must be declared in the version it targets) in `packages/modules/src/schema/lint.ts`
- [X] T105 [US6] Emit `schema:breaking` once per session per `{type, version}` on activation of a `breaking` version in `packages/modules/src/host/activate.ts`

**Checkpoint**: All six stories work independently and together.

---

## Phase 9: Polish & Cross-Cutting Concerns

- [X] T106 [P] E2E test in `tests/e2e/crashing-module.spec.ts` (SC-005): a module whose `activate` throws, one whose view throws on connect, and one whose feature throws five times; all other modules stay functional, the failures appear in `host.report()` with reasons, and the page shows an error placeholder only where the failing view sits
- [X] T107 [P] Write `docs/building-a-module.md` (a single-type module with a list view, from scratch, using only `defineModule`, a schema and `ctx.ui.LiveElement`) and `docs/app-config.md` (every `AppConfig` field, hosting notes from `contracts/pwa-output.md`, CSP and `blob:`, schema evolution rules, runtime manifest workflow)
- [X] T108 [P] Add `packages/modules/README.md` and `packages/app-build/README.md` (public API, what is and is not enforced by access declarations, the dependency list)
- [X] T109 [P] Benchmarks in `packages/modules/bench/`: registering 50 modules with 200 types under 100 ms on the phone profile (4x CPU slowdown); schema validation adds under 5% to ingest time for 10,000 packets
- [X] T110 Time the SC-002 walkthrough: a person (or a fresh agent session) follows `docs/building-a-module.md` from scratch; record the time (target under 30 minutes) and any friction in `specs/003-modules-app-assembly/validation.md`
- [X] T111 Security review against the constitution in `specs/003-modules-app-assembly/validation.md`: no `@sync/core` import path from module code in either build path; the production build refuses the plaintext codec; the runtime loader executes only verified bytes from the same origin; CSP is set; access is documented as API-level, not a sandbox
- [X] T112 Run the whole suite (`npm run typecheck`, `npm run lint`, `npm run test`, `npm run test:contract`, `npm run test:mixed-versions`, `npm run e2e`) and record the results, the 10,000-run validation property and the 1,000-run convergence property in `specs/003-modules-app-assembly/validation.md`
- [X] T113 Run each scenario in `quickstart.md` (S1 to S7) and tick off the result in `specs/003-modules-app-assembly/validation.md`

---

## Dependencies & Execution Order

### Phase dependencies

- **Setup (Phase 1)**: no dependencies
- **Foundational (Phase 2)**: depends on Setup; blocks all stories. The amendments (T008 to T013) block anything that touches the core registry (T056, T102)
- **US1 (Phase 3)**, **US2 (Phase 4)**: both depend only on Phase 2 and can run in parallel; their only shared files are `host/activate.ts`, `app/start-app.ts` and `access/facade.ts`, so land US1's versions first and have US2 edit them (T056, T057, T058)
- **US3 (Phase 5)**: depends on US1 (it builds the sample app and `startApp`); `sw-register` also uses host events from T035
- **US4 (Phase 6)**: depends on US1 (host) and US2 (validator boot window and `revalidate`), plus US3 for `buildApp` to copy runtime modules (T084)
- **US5 (Phase 7)**: depends on US1 (facade, host); independent of US3 and US4 except the banned-import check also guards `buildModule` (T083)
- **US6 (Phase 8)**: depends on US2 (validator, `prepareWrite`) and Phase 2 amendment C-2
- **Polish (Phase 9)**: after the stories you ship

### Within each story

- Tests first, confirm they fail, then implement
- Types and pure functions before host wiring; host wiring before sample app and e2e

### Parallel opportunities

- Phase 1: T002 to T007 together after T001
- Phase 2: T008 to T010 together; T012 with T011 only if they do not both edit `core.ts` at once (T011 first); T014 to T017 together; T018 to T021 together
- US1: T026 to T032 together; T036 to T038 together; T042 and T044 in parallel with host work
- US2: T047 to T050 together; T053 and T054 together
- US3: T059 to T062 together; T065 to T067 together
- US4: T072 to T076 together; T078, T079, T083 together
- US5: T085 to T088 together; T090 and T092 together
- US6: T094 to T097 together; T101 alone first, then T102 to T105

### Parallel example: User Story 1

```text
Together: T026 T027 T028 T029 T030 T031 T032   (all new test files)
Together: T036 T037 T038                       (ui/live-element, ui/wrap-element, features/runner)
Then:     T034 -> T039 -> T040 -> T041         (resolve, facade, activate, startApp)
Together: T042 T044                            (testkit module contract, sample modules)
```

---

## Implementation Strategy

### MVP first (US1 + US2 + US3, all P1)

1. Phase 1 and Phase 2 (amendments first, gate S0 green)
2. US1 and US2 in parallel, then US3
3. Validate with quickstart S1, S2, S3 and S7 (isolation part). This is a complete app builder: bundled modules, validated schemas, static installable offline PWA

### Incremental delivery

1. Add US4 (runtime modules) and validate S4
2. Add US5 (access enforcement) and validate S5
3. Add US6 (schema evolution) and validate S6
4. Polish: docs, benchmarks, security review, full suite

### Notes

- If a task needs a name or shape not in the contracts, change the contract file first (and note why in the commit), then the code
- Keep every verdict in the schema validator a pure function of the packet and schema; any state-dependent rule breaks convergence (research R-04)
- Never add a runtime dependency to `@sync/modules`; T006 enforces this
