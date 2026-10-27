# Validation: Modules & App Assembly

Record of how 003 was checked (tasks T110 to T113). Run in the Claude Code cloud container on 2026-10-26, Node 22, Chromium 1243 (Playwright).

## Results (T112)

| Check | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm run lint` | clean |
| `npm run test` (all packages) | 124 files, 881 tests passed |
| `npm run test:contract` | 97 tests passed |
| Schema validation vs oracle (SC-003) | 10,000 generated schemas and bodies, 100% agreement; a violation-only run refuses 100% of violating bodies |
| Mixed v1/v2 convergence (SC-004), `npm run test:mixed-versions` | 1,000 randomized runs with a `down` mirror, plus a no-`down` variant (200 runs): all peers' `stateHash` equal, no packet refused because of a version difference, every field anyone wrote still stored on every peer, same-version peers show the same thing, and with the mirror a v1 peer's `title` equals a v2 peer's `name` |
| `npm run e2e` (all 13 browser tests) | 13 passed in two consecutive runs, and in a third; see "Flake" below |
| Core suites after amendments C-1, C-2, C-3 | unchanged tests green (gate S0) |

The mixed-version property was mutation-checked: making `migrate.rename` ignore clocks makes it fail after 14 runs (`name vs title`).

### Flake (not caused by 003)

In the first full e2e run, `tests/e2e/invite-offline-webrtc.spec.ts` (spec 002) failed once: it expected a refusal matching `/role/` and received `Packet rejected: unknown-device`. It then passed 4 of 4 runs alone and in the next two full runs. 003 does not touch that path (invite handshake and authority rules); the assertion depends on which rejection reason is reported first, which looks timing-dependent under parallel load. Left as is.

## Success criteria

| Criterion | Evidence |
|---|---|
| SC-001 sample app, two modules, plain static host, installable | `tests/e2e/pwa-static.spec.ts`: built sample app served by a file-only server at `/` and at `/apps/sample/`; `Page.getInstallabilityErrors` is empty in a non-incognito profile; `app:offline-ready`; data written, network cut, reload: shell, modules and data load. `verify-installable` passes. |
| SC-002 new single-type module with a list view in under 30 minutes | Walkthrough below. **Not independently timed** (see open items). |
| SC-003 100% of schema-violating writes and packets refused | Oracle property above (10,000 runs); `schema-sync.test.ts` for the local write and an injected remote packet. |
| SC-004 mixed v1/v2 converge, no loss of v1 fields | Property above (1,000 runs) and `mixed-version-sync.test.ts`. |
| SC-005 a crashing module leaves the others functional | `tests/e2e/crashing-module.spec.ts` (activation throws, view throws on connect, feature fails five times; the other modules and the page keep working, failures reported with reasons) and unit tests T027, T029, T030. |

## Performance (T109), measured here and scaled by the plan's 4x phone profile

| Target | Measured |
|---|---|
| Register 50 modules / 200 types under 100 ms on the phone profile | 4.0 ms here, about 16 ms on the profile |
| Schema validation adds under 5% to ingest of 10,000 packets | +0.9% (1,365 ms plain, 1,378 ms checked; the test asserts under +20% to tolerate noisy runners) |
| Micro-benchmarks (`npm run bench -w @sync/modules`) | `validateBody` about 1.8M/s, `prepareWrite` with mirror about 1.9M/s, `project` through one migration about 390k/s |

## SC-002 walkthrough (T110)

I (the implementer) followed `docs/building-a-module.md` literally: extracted its code blocks unmodified, added a `recipes`
module, wired it into the sample app, and ran `npm run check`, `npm run build`, the contract test from step 5, then
served the build and, in Chromium, added a recipe online, went offline, reloaded, and saw the app and the recipe.
Everything worked first time. The steps took 42 seconds of machine time.

This is **not** a measure of SC-002. The target is a developer, reading and typing, under 30 minutes. It shows only that
the documented path has no dead ends. Friction found while writing the guide, and fixed: schema migrations needed the
`migrate` helpers but modules may not import values from `@sync/modules` (that would copy the runtime into a module), so
the helpers got their own tiny `@sync/modules/migrate` entry that bundled and runtime modules may both import.
The walkthrough changes were reverted; the sample app does not include `recipes`.

## Security review (T111) against the constitution

| Check | Result |
|---|---|
| No import path to `@sync/core` or `@sync/spaces` from module code, in both build paths | `buildApp` and `buildModule` refuse value imports of internals during resolution (including subpaths and in the config run), listing each file and import; type-only imports are fine. Eslint carries the same rule for module folders. `app-build/tests/banned-imports.test.ts`. |
| Production refuses the plaintext test codec (Principle V) | `buildApp` fails on `security: 'plaintext-for-tests'` in production; `startApp` refuses it unless a core is injected and the mode is not production, and calls `assertSecureCore` otherwise. |
| The runtime loader runs only verified, same-origin bytes | Entries are same-origin http(s) only (`bad-scheme`, `cross-origin`); fetches use `redirect: 'error'` and the response URL's origin is re-checked; with `integrity` the SHA-256 must match; the exact verified bytes run from a blob URL; a bundled id cannot be replaced. |
| CSP set | Generated page: `script-src 'self' blob:`, `connect-src 'self'` plus only the configured origins. |
| Access declarations documented as API-level | `docs/app-config.md`, `packages/modules/README.md`. |

Findings from the review:

1. **Fixed: the host was published on `window.__syncHost`.** The generated entry exposed the host, which reaches `host.core`, so any module could get the raw core and bypass its declarations. Now off in production builds; on only in development builds or with `exposeHost` / `--expose-host` (the e2e tests build with it). Covered by a build test.
2. **`integrity` is optional in the manifest.** Without it, same-origin bytes run unverified. Accepted by the spec's same-origin trust model; the docs say to use it, and `buildModule` always produces one.
3. **Same-origin code is not contained.** A runtime module (or any script on the page) can still open IndexedDB, use the non-extractable key handles in `sync-keys`, or edit the device-local Space bindings in `sync-modules`. This is the spec's stated assumption, not a gap in the facade; stated in the docs.
4. **The "no imports" check in the loader is a heuristic.** It exists for a clearer error; the real guarantee is that a blob module cannot resolve imports, and `buildModule` checks the bundle's imports from esbuild's metafile.
5. **Opaque data.** After the boot window, packets for a type nobody registered are accepted unvalidated (kept, relayed, not shown), to avoid the 001 parked-packet limit dropping data (research R-09). When the module appears later, stored values are checked on read and reported (`schema:violation`).

## Deviations from the plan

Decided during implementation, with the reason. Plan text, contracts and research were updated where they described the old behavior.

1. **Core amendment C-3**: `update(id, fields, { schemaVersion })`. An update packet carried the object's existing version, so a v2 peer editing a v1-created object would have sent v2 names labeled v1 and every peer would have refused them as `unknown-field`.
2. **`@sync/modules/migrate`** subpath for the migration helpers (see walkthrough).
3. **Loader cache**: lookup by module id as well as URL, and pruning after loading instead of when the manifest arrives. As first written, a new version with a new file name could never fall back to the cached older one, and the older copy was deleted before the new file was tried. Found by the e2e.
4. **`runtime.waitForBoot`** (new, default false): on a very first launch with nothing cached, waiting for the manifest would delay bundled modules; only apps with `boot: true` modules opt in.
5. **`onReady` and `connectSrc`** added to the App Config (analysis findings C1, F1). **`host.ready()`**, `contextOf`, `addModules`, `markRuntime` and `closeBootWindow` on the host for orchestration and tests.
6. **`app:*` and `sw:*` events are replayed to late subscribers**: the worker can finish before the UI attaches a listener.
7. **`app:offline-ready` means a worker is active** (the shell is fully cached and the next launch works offline), not "and controlling this page": without `clients.claim()` the first page is not controlled until reload, by design.
8. **Uniform denials**: `update`/`remove`/`undo`/`history` on a missing object, an undeclared type or an unbound Space throw the same `AccessDeniedError`; `get` returns `undefined`; details go to the `access:denied` event only.
9. **`LiveElement` instance interface** exposes `bind`, `connectedCallback` and `disconnectedCallback` publicly (TypeScript's `protected` cannot be expressed on the injected interface).
10. **`DataFacade.create`** takes an optional `{ id }`, used by tests for deterministic objects.
11. **Report**: `host.report()` returns copies; module reports list what a module declares, whether or not it took effect.

## Open items

- **SC-002 needs an independent timing**: a developer (or a fresh agent session) following `docs/building-a-module.md` from scratch, with the time recorded here. T110 is marked done on the basis of the implementer's run above, which is not that measurement.
- Defaults to know: modules use `bound` Space access unless they declare `any`, so a new app must bind Spaces in `onReady` (the sample does). First launch of an app with `boot: true` modules needs `runtime.waitForBoot`.
- Low-severity analysis findings F2, F3, E2, B1, B2, U1, U2 from `/speckit-analyze` were not addressed beyond what implementation covered: `sw:unavailable` was added to `HostEvent` and `stopped` to `ModuleStatus` (F2); first-view-without-network (E2) is shown by the e2e flow but not asserted separately.
