# Quickstart: Validation Scenarios

Runnable checks that prove the feature end-to-end. Contracts: [module-api.ts](./contracts/module-api.ts), [schema.ts](./contracts/schema.ts), [runtime-manifest.md](./contracts/runtime-manifest.md), [pwa-output.md](./contracts/pwa-output.md). Entities: [data-model.md](./data-model.md). Map: S1→US1, S2→US2, S3→US3, S4→US4, S5→US5, S6→US6, S7→SC-002.

## Prerequisites

```bash
npm install
npx playwright install chromium     # or set PW_CHROMIUM_PATH
npm run typecheck && npm run lint
```

The sample app is `packages/sample-app` (modules `todo` and `stats`; `stats` depends on `todo`). Output goes to `packages/sample-app/dist`.

## S1: Build an app from bundled modules (US1)

```bash
npm run build -w @sync/sample-app          # buildApp(config) -> dist/
npx vitest run packages/modules/tests/integration/bundled
```

Expect: both modules `active`, registered in dependency order (`todo` before `stats`); `todo-list` renders rows and updates when an object is created or edited; two modules declaring the same type or element name fail the later module with an error naming both (`host.report()` shows `failed` and its reason); the app and the other module still run.

## S2: Schemas validate data (US2, SC-003)

```bash
npx vitest run packages/modules/tests/unit/schema packages/modules/tests/property/validation
```

Expect: a local write violating the schema throws `SchemaValidationError` and no packet exists (`core.history` unchanged); an injected remote packet violating the schema is rejected and not applied; the same packet with a **newer** schema version is stored and relayed (check with a second core); with `editResurrects` a concurrent delete and edit leaves the object visible, without it the object stays deleted. The property test compares `validateBody` to an independent oracle over ≥ 10,000 generated valid and invalid bodies: 100% agree.

## S3: Static PWA (US3, SC-001)

```bash
npm run build -w @sync/sample-app
node -e "require('@sync/app-build').verifyInstallable('packages/sample-app/dist').then(r=>{console.log(r);process.exit(r.ok?0:1)})"
npx playwright test tests/e2e/pwa-static.spec.ts
```

Expect: `verifyInstallable` returns `ok: true`. The Playwright test serves `dist` with a file-only server (no API, no rewrites) at the root and again under `/apps/sample/`, checks `Page.getInstallabilityErrors` is empty both times, waits for `app:offline-ready`, then sets the context offline and reloads: shell, both modules and previously written data load from the device.

## S4: Runtime modules (US4)

```bash
npm run build:runtime -w @sync/sample-app  # buildModule for runtime-modules/notes -> dist/modules/
npx playwright test tests/e2e/runtime-modules.spec.ts
```

Expect: with `notes` listed in `dist/modules/manifest.json`, the first online start loads, registers and caches it; after going offline and reloading it still loads (from `sync-modules-v1`). An entry with another origin is refused and logged (`module:refused`, `cross-origin`) and the rest of the app is unaffected. With the module file removed from the host the app starts using the cached copy (`module:stale`), or without it when never cached (`module:unavailable`). A changed integrity hash refuses the new file and keeps the old copy. Updating the manifest while the app is open emits `module:update-available` and changes nothing until reload.

## S5: Access declarations (US5)

```bash
npx vitest run packages/modules/tests/integration/access
```

Expect: a module querying or writing an undeclared type, or a Space that is not bound to it, gets `AccessDeniedError` (the same error for a nonexistent object), and the host emits `access:denied`. `host.report()` lists each module's declared access and registrations. `buildModule` fails on `import '@sync/core'`.

## S6: Evolve a schema (US6, SC-004)

```bash
npx vitest run packages/modules/tests/property/mixed-versions
```

Expect, over ≥ 1,000 randomized runs with a v1 host and a v2 host connected through the testkit memory transport and each editing the same objects: all peers' core `stateHash` equal; v2 projections identical across v2 peers; every v1 field value written by any peer is still present in storage on every peer; v1 peers keep all v2-written fields (unseen by their projection); with `down` defined, v1 peers also see v2 edits to renamed fields.

## S7: Crash isolation and developer effort (SC-005, SC-002)

```bash
npx vitest run packages/modules/tests/integration/isolation
npx playwright test tests/e2e/crashing-module.spec.ts
```

Expect: modules whose `activate` throws, whose view throws on connect, and whose feature throws five times each leave all other modules functional; the failing ones appear in `host.report()` with reasons and the page shows an error placeholder only where the failing view sits.

SC-002 is checked by following `docs/building-a-module.md` from scratch (new single-type module with a list view); the target is under 30 minutes and the timing is recorded in `validation.md`.

## Module contract suite

```ts
import { moduleContract } from '@sync/testkit';
moduleContract({ name: 'todo', definition: todoModule });
```

Any module (first-party or third-party) can run this to prove it follows the contract (Principle VIII).
