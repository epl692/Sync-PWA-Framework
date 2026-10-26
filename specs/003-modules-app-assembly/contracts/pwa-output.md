# PWA Output

Normative for FR-013 and User Story 3. Produced by `buildApp`; checked by `verifyInstallable` and by the Playwright static-host test.

## Layout

```text
<outDir>/
├── index.html                  # shell, CSP meta, links manifest, loads app.[hash].js as a module
├── app.[hash].js               # core + @sync/modules runtime + bundled modules + app config
├── app.[hash].css              # only if modules import CSS
├── manifest.webmanifest
├── sw.js
├── icons/{icon-192.png, icon-512.png, maskable-512.png?}
├── modules/                    # optional, copied from the sample's runtime modules
│   ├── manifest.json
│   └── <module>.<version>.js
└── (assets listed in config.assets)
```

All references are **relative**. No file requires server-side code, redirects, rewrites or special headers.

## Web manifest

| Member | Value |
|---|---|
| `name`, `short_name`, `description` | from the config |
| `start_url` | `./` |
| `scope` | `./` |
| `display` | `standalone` |
| `theme_color`, `background_color` | from the config |
| `icons` | 192, 512, and a `maskable` 512 when given |

`id` is set to `./` so moving the host path does not make a new app identity inside one origin.

## `index.html`

- `<meta name="viewport" content="width=device-width, initial-scale=1">`, `<meta name="theme-color">`, `<link rel="manifest">`.
- CSP: `default-src 'self'; script-src 'self' blob:; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss: https:; img-src 'self' data: blob:`. `connect-src` is widened by transports through the config only. `blob:` is required by the runtime loader (research R-08).
- A single `<div id="app">` and the `<script type="module">`. Apps may place any registered custom element in `index.template.html`.

## Service worker (`sw.js`, generated)

1. **Precache list**: every emitted file with its revision (SHA-256), embedded as a constant. Cache name `shell-<build hash>`.
2. **install**: add all precache entries (`cache.addAll`); activation waits until this completes, so a worker that activates is guaranteed to have a full shell offline. A failed install leaves the previous worker in place.
3. **activate**: delete caches named `shell-*` other than the current one; `clients.claim()` is NOT called (a page controlled by an older worker keeps one consistent version until reload).
4. **fetch**:
   - Navigation requests: `index.html` from the cache (network is not consulted), with a network fallback if it is somehow missing.
   - Precached same-origin GETs: cache-first.
   - `modules/*` and everything else: untouched (the browser handles them; the loader owns module caching).
   - Non-GET and cross-origin: untouched.
5. **message** `{type:'skipWaiting'}`: `skipWaiting()`. Sent only by `host.applyUpdate()`.
6. First install: after the worker activates and the page is controlled, the host emits `app:offline-ready`. A later installed worker waits, and the host emits `app:update-ready`.

## Offline from first launch after install

Install precaches the shell and bundled modules (inside `app.[hash].js`). With the device offline the next launch is served from the precache; the cached runtime manifest and modules load from `sync-modules-v1`; object data is local (IndexedDB). A visit that never completed install is not guaranteed offline.

## Installability checks

`verifyInstallable(outDir)` fails when any of these is not true:

- `manifest.webmanifest` parses and has `name` or `short_name`, `start_url`, `display` in `standalone | fullscreen | minimal-ui`, and icons including a 192 and a 512 PNG that exist and have those dimensions.
- `index.html` links the manifest and registers `sw.js`.
- `sw.js` exists, contains a `fetch` listener, and its precache list matches the files on disk (revisions verified).
- `start_url` and `scope` resolve inside the app path.

The Playwright test additionally requires `Page.getInstallabilityErrors` (DevTools protocol, Chromium) to return an empty list when the output is served by a plain static file server on `localhost` and when served under a subpath.

## Hosting notes (for docs)

HTTPS (or `localhost`) is required for service workers. Serve `sw.js` with a short cache lifetime (or `no-cache`) so updates are noticed; hashed assets can be cached forever. If a host forces redirects from `/sw.js`, installation fails and `app:offline-ready` is never emitted; the host reports `sw:unavailable` and the app continues online-only with data still local.
