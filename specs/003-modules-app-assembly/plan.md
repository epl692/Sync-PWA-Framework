# Implementation Plan: Modules & App Assembly

**Branch**: `003-modules-app-assembly` | **Date**: 2026-10-26 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/003-modules-app-assembly/spec.md`

## Summary

Add the Module contract, versioned object-type schemas, Web Component views, bundled and runtime-loaded modules, access enforcement, and a build that turns an app config into a static, installable, offline PWA. It plugs into the finished 001 core (validators, reactive queries, "edit resurrects") and 002 spaces (`openSecureCore`) without changing the wire format.

Technical approach (details in [research.md](./research.md)):

- **Declarative modules** (`defineModule`): types, views, features, transports and identity providers are data the host can inspect and validate before any module code runs. Names are namespaced by module ID, so collisions fail with a clear error (R-02).
- **Everything arrives through `ModuleContext`**: no runtime imports from the framework, so a bundled module and a runtime-loaded module are the same artifact and obey the same contract (R-03).
- **Resolve, boot core, activate**: registration is transactional per module; a failing module (or a throwing view or feature) is isolated and its dependents are skipped, the rest keep running (R-05).
- **Schemas are plain data validated by a pure function** of the packet and the schema, so every peer reaches the same verdict and convergence is untouched (R-04). One `PacketValidator` serves both the `send` and `apply` phases.
- **Schema evolution is read-time and additive**: packets are never rewritten; migrations run on the converged state with field clocks; v1 peers keep syncing and no v1 field is lost (R-07).
- **Runtime modules**: same-origin only, fetched, optionally integrity-checked, cached by the loader, then imported from a blob of the verified bytes. Boot never waits on the network (R-08).
- **Access declarations are enforced by a facade** and backed by build-time import checks; documented as API-level enforcement, not a sandbox (R-10).
- **Packaging**: esbuild-driven `buildApp` emits hashed assets, web manifest and a generated precache service worker; installability is checked statically and with Chromium's `Page.getInstallabilityErrors` (R-01, R-14).
- **Review of 001/002 found two gaps this feature closes with two additive core amendments** (C-1 mutable type registry, C-2 optional field clocks on reads) and one hazard it works around (parked-packet overflow drops data, R-09). See [contracts/core-amendments.md](./contracts/core-amendments.md).

## Technical Context

**Language/Version**: TypeScript 5.x strict, ES2022; Node 20 LTS for the build tool.

**Primary Dependencies**:
- `packages/modules` (`@sync/modules`): **none at runtime**.
- `packages/app-build` (`@sync/app-build`): `esbuild` (Node tooling, never shipped to browsers).
- `packages/sample-app`: its own two modules and an HTML shell, no dependencies beyond the framework.
- Dev/test: existing `vitest`, `fast-check`, `fake-indexeddb`, `@playwright/test`; new dev dependency `jsdom` for custom element unit tests.

**Storage**: No new synced store. Runtime module files and the runtime manifest are cached in Cache Storage (`sync-modules-v1`) by the loader. The app shell is cached by the generated service worker (separate cache name per build). Object data uses the 001 stores unchanged.

**Testing**: Vitest for unit, contract, integration. fast-check for schema validation (oracle comparison, SC-003) and mixed-version convergence (SC-004). jsdom for `LiveElement` and element wrapping. Playwright (Chromium) for the static-host app: install audit, offline reload after first visit, runtime module add, refused cross-origin entry, crashing module isolation (SC-001, SC-005). A `moduleContract()` suite ships in `@sync/testkit` (Principle VIII).

**Target Platform**: Evergreen browsers (Chrome, Edge, Safari including iOS, Firefox) with custom elements, Cache Storage, Web Crypto, service workers. Web Locks for singleton features (degrades to every-tab with a warning). Node 20 for `@sync/app-build`.

**Project Type**: Library monorepo, two new packages and one sample app added to the existing workspaces, plus additive changes to `core` and `testkit`.

**Performance Goals**: Bundled modules registered and first view rendered without waiting on network. Registering 50 modules with 200 types < 100 ms on the phone profile (4x slowdown). Schema validation adds < 5% to ingest time for 10k packets. Time for a developer to add a single-type module with a list view: under 30 minutes using the docs (SC-002, measured by a documented walkthrough).

**Constraints**: Offline-first: nothing in boot blocks on a network request longer than the 2.5 s manifest timeout, and bundled modules never wait for it. No UI framework in the core. No runtime dependencies. Output is static files only.

**Scale/Scope**: Designed for up to ~50 modules, ~200 object types, and ~100 views per app. Runtime manifests of up to ~50 entries.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | How the plan satisfies it |
|---|---|---|
| I. Offline-first | PASS | Bundled modules and the shell are precached; boot never blocks on the network (manifest fetch has a timeout and falls back to cache); runtime modules are cached by the loader. Validation and migration are local. |
| II. Everything is a Syncable Object | PASS | Modules only read and write Syncable Objects through the data facade. Module settings that must sync are objects too; local-only module settings are explicitly device-local and not synced app data. No module-private store for synced data. |
| III. Packets are the only way state changes | PASS | The facade calls `core.create/update/remove`, so all writes are packets through the single apply path. Validation is a pure function of packet and schema, so it cannot cause divergence; migration is a read-time projection and never mutates state. Property tests cover mixed-version convergence. |
| IV. Transport agnostic | PASS | Transports are module registrations that implement the unchanged 001 Transport contract; the host only calls `addTransport`. Nothing here depends on a transport. |
| V. Zero-trust, E2E | PASS | No change to packets, signing or encryption. `startApp` uses `openSecureCore` and refuses the plaintext test codec in production builds. Schema checks run in addition to 002 signature and role checks, never instead. Runtime modules are same-origin and integrity-checked; the plan states plainly that access enforcement is not a sandbox. |
| VI. Modular | PASS | This feature is the Module contract. The core stays free of app views and features (the sample modules live in `sample-app`). A module declares the types and Spaces it reads and writes, and the facade enforces it. Bundled and runtime use one contract. |
| VII. Static-hostable | PASS | The build emits plain files with relative URLs and a generated service worker; no server code; verified on a minimal file-only host and under a subpath. |
| VIII. Contract-tested, test-first | PASS | `moduleContract()` ships in testkit; a `checkSchema` lint; property-based schema and convergence tests; tasks put tests before implementation. |

**Technical constraints**: strict TS; native Web Components with an optional thin base class; IndexedDB and Web Crypto only through the core; zero runtime dependencies; every object type has a versioned, validated, migratable schema (enforced by `checkSchema` at registration).

**Compatibility note (required by Development Workflow):** This feature does **not** change the packet envelope, signing, encryption or the Transport contract. Schema evolution rules for older and newer peers are in [contracts/schema-rules.md](./contracts/schema-rules.md#compatibility): packets of a newer schema version are accepted, stored and relayed with unknown fields kept; older-version packets are validated against their own version; no packet is rewritten. The two core amendments are additive API changes with no wire effect ([contracts/core-amendments.md](./contracts/core-amendments.md)).

**Post-design re-check (after Phase 1):** PASS. Items examined and justified rather than waived:
1. *Unknown types after the boot window are accepted unvalidated.* This is the only way to avoid silent data loss from the 001 parked-packet limit (R-09); the read-time field check covers the gap.
2. *Access declarations are not a security boundary against hostile same-origin code.* Accepted by the spec's Assumptions; mitigated by build-time import bans.
3. *Blob-URL loading requires `blob:` in the CSP.* Chosen so that exactly the verified bytes execute (R-08); documented and set in the generated HTML.
4. *`esbuild` as a dependency of the build package.* Tooling only, already used in the repo.

## Project Structure

### Documentation (this feature)

```text
specs/003-modules-app-assembly/
├── plan.md              # This file
├── research.md          # Phase 0: decisions, rationale, alternatives
├── data-model.md        # Phase 1: entities, statuses, state transitions
├── quickstart.md        # Phase 1: validation scenarios
├── contracts/
│   ├── module-api.ts        # Module definition, context, data facade, host API
│   ├── schema.ts            # Object type schema, field types, migrations, validator API
│   ├── schema-rules.md      # validation algorithm, version rules, migration, compatibility
│   ├── runtime-manifest.md  # manifest format, loading, caching, refusal rules
│   ├── app-config.ts        # App Config and build API (buildApp, buildModule, verifyInstallable)
│   ├── pwa-output.md        # build output layout, web manifest, service worker behavior
│   └── core-amendments.md   # C-1, C-2 additive changes to @sync/core
└── tasks.md             # Phase 2 (/speckit-tasks, not created here)
```

### Source Code (repository root)

```text
packages/
├── core/                    # AMENDED (C-1, C-2): registerType(), field clocks on reads
├── testkit/                 # ADDED: moduleContract(), fakeModuleHost, mixed-version peer builder
├── modules/                 # NEW  @sync/modules (browser runtime, zero deps)
│   ├── src/
│   │   ├── definition/      # defineModule, id/name rules, semver, access normalization
│   │   ├── schema/          # field types, checkSchema lint, validate(), project(), migrations
│   │   ├── validator/       # SchemaValidator (PacketValidator for send + apply)
│   │   ├── host/            # resolve, boot, activate, rollback, status/report, events
│   │   ├── access/          # data facade, space binding, AccessDeniedError
│   │   ├── ui/              # LiveElement, element wrapper (error boundary)
│   │   ├── features/        # feature runner, Web Locks singleton, failure counting
│   │   ├── loader/          # runtime manifest, same-origin check, integrity, Cache Storage, blob import
│   │   ├── app/             # startApp(config): core + spaces + host + SW registration
│   │   └── index.ts
│   └── tests/{unit,property,contract,integration}/
├── app-build/               # NEW  @sync/app-build (Node)
│   ├── src/
│   │   ├── build-app.ts     # esbuild entry generation, hashing, html/manifest/sw emit
│   │   ├── build-module.ts  # single-file ESM runtime module + banned-import check
│   │   ├── sw-template.ts   # generated service worker
│   │   ├── installable.ts   # verifyInstallable(outDir)
│   │   ├── check-modules.ts # CLI: resolve + checkSchema over an app config without a browser
│   │   └── index.ts
│   └── tests/
└── sample-app/              # NEW  workspace "@sync/sample-app" (not published)
    ├── app.config.ts
    ├── modules/{todo,stats}/    # todo: type + list view + editor; stats: depends on todo, feature + view
    ├── runtime-modules/notes/   # runtime-loaded example added in US4 validation
    ├── public/{icons}
    └── index.template.html
tests/e2e/                   # Playwright: static-host install audit, offline, runtime module, crash isolation
docs/                        # building-a-module.md (SC-002 walkthrough), app-config.md
```

**Structure Decision**: Two new packages keep the browser runtime (`modules`, zero dependencies, shipped to users) apart from the Node build tool (`app-build`, which has the one tooling dependency). The sample app is its own workspace so the core and `modules` stay free of app-specific views and features (Principle VI) and so the acceptance tests exercise a real build. `testkit` carries the test-only pieces so none is bundled into a release. Core changes are additive so 001 and 002 tests are unaffected when the modules package is not installed.

## Complexity Tracking

No constitution violations. Noted for transparency:

| Item | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| Own semver range parser and schema checker instead of libraries | Zero runtime dependencies in the shipped runtime | `semver` and a validation library would be the first runtime dependencies for a few hundred lines of owned code |
| Loader owns a module cache instead of relying on the service worker | The bytes that run must be the bytes that were verified, and FR-011 must hold even if the worker is unavailable | Service-worker-only caching lets redirects and stale entries slip past the integrity check |
| Three-phase boot (resolve, boot core, activate) | An identity provider must exist before the core opens, while modules need the core to register types | One-phase registration cannot support provider modules or transactional rollback |
| Two core amendments | Core needs mutable type registration and optional field clocks | Working around them in the modules package would duplicate core state or make migrations clock-blind and non-convergent |
