# @sync/app-build

Build tool (Node only, never shipped to browsers). One dependency: `esbuild`.

```bash
sync-check-modules app.config.ts           # CLI: tsx packages/app-build/src/cli.ts <command>
```

| Command | Does |
|---|---|
| `build <config> <outDir> [--dev] [--expose-host]` | Bundles the app and writes `index.html`, hashed JS, `manifest.webmanifest`, a generated service worker, icons and runtime modules. |
| `build-runtime <config> <outDir>` | Builds only the runtime modules and their manifest. |
| `check-modules <config>` | Resolves modules and lints schemas with no browser. Exit code 1 on any problem. |
| `verify-installable <dir>` | Static installability checks (manifest, icons, worker with a fetch handler, precache revisions). |

API: `buildApp`, `buildModule`, `buildRuntimeModules`, `verifyInstallable`, `checkModules`, `generateServiceWorker`.

What the build refuses, with every problem listed: invalid module definitions, schemas that do not lint, duplicate or
unsatisfiable modules, missing or wrongly sized icons, the plaintext test codec in production, and module code that
imports framework internals (`@sync/core`, `@sync/spaces`, ...). Runtime modules must be a single file with no imports.

See [docs/app-config.md](../../docs/app-config.md) and `specs/003-modules-app-assembly/contracts/pwa-output.md`.
