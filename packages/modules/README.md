# @sync/modules

The browser runtime that turns the sync core into an app: the **Module contract**, declared and versioned **schemas**,
**views** as Web Components, **bundled and runtime-loaded** modules, **access declarations**, and `startApp`.
Zero runtime dependencies.

```ts
import { startApp } from '@sync/modules';
import config from './app.config';
await startApp(config);
```

- **Module**: `{ id, version, dependencies, access, provides: { types, views, features, transports, identityProviders } }`. Declared as data, so the host can inspect it before running anything. See [docs/building-a-module.md](../../docs/building-a-module.md).
- **Schemas**: field types and rules, versions with `up`/`down` migrations (`@sync/modules/migrate`), merge options (`editResurrects`). Validation is a pure function of the packet and the schema, so every peer reaches the same verdict.
- **Host**: resolves modules in dependency order, activates each one transactionally, and isolates failures (a module that throws, a view that throws, a feature that keeps failing never stop the others). `host.report()` lists every module's status, declared access and registrations.
- **Access**: a module gets `ctx.data` (checked against its declared types and Spaces) and `ctx.spaces`, never the core, keys or signer. This is an API-level guard, not a sandbox against hostile same-origin code.
- **Runtime modules**: same-origin only, integrity-checked, cached by the loader for offline use. See [docs/app-config.md](../../docs/app-config.md).

Exports: `startApp`, `createHost`, `defineModule`, `LiveElement`, `checkSchema`, `validateBody`, `project`, `prepareWrite`, `migrate`, `RuntimeLoader`, `Bindings`, `AccessDeniedError`, and the contract types.

Tests: `npm run test:modules`; the mixed-version property test: `npm run test:mixed-versions`; performance budgets: `packages/modules/tests/perf`.
Contract suite for your own modules: `moduleContract()` in `@sync/testkit`.
