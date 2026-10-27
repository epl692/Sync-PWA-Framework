# App Config and hosting

An app is a TypeScript file, `app.config.ts`, that imports its modules and default-exports the config. `buildApp`
bundles it (listing a module in `modules` is what bundles it) and writes plain static files.

```ts
import type { AppConfig } from '@sync/modules';
import identity from './infra/identity/index';
import todo from './modules/todo/index';

export default {
  name: 'Sample Todo',
  themeColor: '#2b6cb0',
  icons: { src192: 'public/icons/icon-192.png', src512: 'public/icons/icon-512.png' },
  modules: [identity, todo],
  identityProvider: 'identity.invite',
  async onReady(host, spaces) { /* sign up, create a Space, bind it to modules */ },
} satisfies AppConfig;
```

## Fields

| Field | Meaning |
|---|---|
| `name`, `shortName`, `description` | Web manifest. `name` is required. |
| `themeColor`, `backgroundColor` | Hex colors for the manifest and `<meta name="theme-color">`. |
| `icons` | `src192` and `src512` PNGs (checked for exact size); `maskable512` is recommended. Paths are relative to the config. |
| `modules` | Bundled modules, in any order; the host sorts them by `dependencies`. Duplicate IDs, bad definitions, schemas that do not lint, and unsatisfiable dependencies fail the build with every problem listed. |
| `settings` | `{ [moduleId]: { ... } }`, handed to each module as `ctx.settings` (read-only). |
| `identityProvider` | ID (`<moduleId>.<id>`) of the identity provider to use. Default: the first one a module provides. Needed before the core opens, so it comes from a bundled module or a runtime module listed with `boot: true`. |
| `transports` | IDs of the transports to start. Modules can offer several; only these are created. |
| `onReady(host, spaces)` | Called once after the bundled modules are active. Sign the user up, create or choose Spaces, and bind Spaces to modules here. An error is reported and does not stop the app. |
| `blobs({ core, spaces })` | Attachments (spec 004): called once the core is open; return the engine, for example `createBlobs({ core, keys: spaces.blobKeys })`, and define `<sync-blob>` with `defineSyncBlob(blobs)`. Modules then get `ctx.blobs`. App code may import `@sync/blobs`; module code may not. See [blobs.md](blobs.md). |
| `runtime.manifest` | Path of the runtime manifest (default `modules/manifest.json`), or `false` to switch runtime loading off. Apps with no `runtime-modules/` folder switch it off by default. |
| `runtime.manifestTimeoutMs` | How long to wait for the manifest when online (default 2500). Bundled modules never wait for it. |
| `runtime.activateTimeoutMs` | Per-module activation limit (default 5000). |
| `runtime.bootWindowMs` | How long packets for not-yet-registered types are held back (default 10000). |
| `runtime.waitForBoot` | On a first launch with nothing cached, wait for the manifest so `boot: true` modules can load before the core opens. Default `false`. |
| `connectSrc` | Extra origins for the page's `connect-src` (for a relay or other transport server). Without it, pages can talk only to their own origin. |
| `security` | `'spaces'` (default). `'plaintext-for-tests'` is refused in production builds. |
| `assets` | Extra files copied to the output and cached with the app. |

## Building

```bash
npx tsx packages/app-build/src/cli.ts build app.config.ts dist          # production
npx tsx packages/app-build/src/cli.ts build app.config.ts dist --dev    # unhashed names, source maps, host on window.__syncHost
npx tsx packages/app-build/src/cli.ts check-modules app.config.ts       # resolve and lint, no browser
npx tsx packages/app-build/src/cli.ts verify-installable dist           # static installability checks
```

`--expose-host` publishes the host on `window.__syncHost` in any build. Leave it off in production: the host reaches the
core, so any module could use it to get around its access declarations.

The output is `index.html`, a hashed `app.<hash>.js`, `manifest.webmanifest`, `sw.js`, `icons/`, and `modules/` for
runtime modules. All URLs are relative, so the folder works at a domain root or under a subpath, with no rewrites or
special headers.

## Hosting

- **HTTPS** (or `localhost`) is required for service workers and installation.
- Serve `sw.js` with a short cache lifetime (`no-cache` is fine) so updates are noticed. Hashed files can be cached forever.
- If the host redirects `/sw.js`, the worker cannot install: the app keeps working online with its data local, and reports `sw:unavailable`.
- **Content Security Policy.** The generated page sets `default-src 'self'; script-src 'self' blob:; style-src 'self' 'unsafe-inline'; connect-src 'self' <connectSrc>; img-src 'self' data: blob:`. `blob:` is how runtime modules run the exact bytes that were verified. If you add your own policy, keep `script-src ... blob:`.
- **Updates.** A new build installs in the background and waits. The page receives `app:update-ready`; call `host.applyUpdate()` to switch and reload, or it takes effect the next time every tab is closed and reopened.

## Runtime modules

A runtime module is one self-contained ES module file: no `import` statements, and `@sync/*` is imported for types only
(plus `@sync/modules/migrate` for migration helpers). Put it in `runtime-modules/<name>/index.ts`; `build` writes
`modules/<id>.<version>.js` and `modules/manifest.json`.

```json
{ "v": 1, "modules": [ { "id": "notes", "version": "1.2.0", "url": "notes.1.2.0.js", "integrity": "sha256-...", "boot": false } ] }
```

- Entries must be **same-origin** http(s); anything else is refused and logged, and its file is never requested. An entry whose ID is bundled is refused: a manifest cannot replace shipped code.
- With `integrity`, the file must match its SHA-256 or it is refused and the cached copy (if any) keeps running. Without it, same-origin bytes run as they are: use `integrity`.
- Files are cached on first load, and the cached manifest is used when offline. If a file cannot be fetched the cached version runs (status `stale`), or the app starts without it (`unavailable`). Neither stops the app.
- A running module is never swapped. A newer one is fetched and cached in the background (`module:update-available`) and used on the next launch, or after `host.applyUpdate()`.
- A module that provides an identity provider must be listed with `"boot": true`.

## Schemas and versions

See [building-a-module.md](./building-a-module.md) for writing a type. For changing one: a field name keeps its type in
every version; version 2 and later need `up`, and `down` (so older peers still see changes) or `breaking: true`. Old
objects are migrated when read, packets are never rewritten, and a peer on an older version keeps and relays fields it
does not understand. Schema checks protect peers from bad data and bugs; they are not authorization.

## What access declarations do and do not do

A module reaches data only through `ctx.data`, which checks every call against the types and Spaces it declared.
The builds refuse module code that imports `@sync/core`, `@sync/spaces` or other internals. This is an API-level guard,
**not a sandbox**: runtime modules are same-origin code the app developer chose, and such code could still read
IndexedDB or the page directly. Treat a module as trusted code that is kept honest, not as hostile code that is contained.
