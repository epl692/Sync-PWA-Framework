# Runtime Manifest and Loading

Normative for FR-009..FR-011 and User Story 4.

## Manifest file

Served from the app's own origin at `modules/manifest.json` (configurable). Not precached by the service worker (the loader owns its cache).

```json
{
  "v": 1,
  "modules": [
    {
      "id": "notes",
      "version": "1.2.0",
      "url": "notes.1.2.0.js",
      "integrity": "sha256-<base64>",
      "boot": false
    }
  ]
}
```

| Field | Rules |
|---|---|
| `v` | Must be `1`. A higher value is ignored with a warning (unknown manifest version: load nothing new, keep cache). |
| `modules[].id` | Module ID rules. Must equal the `id` the file exports, else `malformed`. |
| `modules[].version` | Semver. Must equal the exported version, else `malformed`. |
| `modules[].url` | Resolved against the manifest URL. |
| `modules[].integrity` | Optional `sha256-<base64>`. When present it MUST match or the file is refused. Produced by `buildModule`. |
| `modules[].boot` | Optional. `true`: fetched before the core opens (required for modules that provide an identity provider). |

Unknown extra fields are ignored. A malformed entry is skipped and reported; other entries still load.

## Refusal rules (FR-010)

An entry is refused (event `module:refused`, logged, no code fetched or run) when:

1. The resolved URL's scheme is not `http:` or `https:` (`bad-scheme`).
2. `new URL(url, manifestUrl).origin !== location.origin` (`cross-origin`).
3. The ID equals a bundled module's ID (`id-clash`). Bundled wins.
4. It provides an identity provider but is not `boot: true` (`provider-after-boot`), checked after load.

Fetches use `redirect: 'error'` and the response URL's origin is re-checked, so a redirect cannot leave the origin.

## Load sequence

```text
start
 ├─ activate bundled modules                (never waits for the network)
 ├─ read cached manifest (Cache Storage)    → entries A
 ├─ fetch manifest, timeout manifestTimeoutMs
 │     ok  → entries B (also stored in cache)
 │     fail→ entries A (event only if A is empty and a network error occurred)
 ├─ for each entry (parallel, activation in dependency order):
 │     1. cache hit with same version + integrity? use it, skip fetch
 │     2. else fetch file (redirect:'error'), verify integrity, store in cache `sync-modules-v1`
 │     3. network failure → cached copy of any version → status `stale`; none → `unavailable`
 │     4. integrity failure → refuse response; keep previous cached copy (stale) if any
 │     5. import(blob URL of the verified bytes); check id/version; add to the dependency resolution
 └─ after all settle (or bootWindowMs): validator.closeBootWindow(); core.revalidate()
```

`boot: true` entries run steps 1–5 before the core opens and are activated with the bundled modules.

## Module file format

A single ES module with `export default defineModule({...})` and **no import statements** (static or dynamic, relative or bare). `defineModule` is an identity function with types, so it is a no-op at runtime. `buildModule` enforces this and bans `@sync/*` internals.

## Cache

`Cache Storage` name `sync-modules-v1`. Keys are absolute URLs. Stores the manifest and each verified module file. Entries not referenced by the latest manifest are removed after a successful load of that manifest. Offline start after one online visit therefore loads manifest and modules from the cache (US4-1, SC-001).

## Updates while open

The loader re-checks the manifest on `online` and `visibilitychange` (at most once per 5 minutes). A newer version is fetched, verified and cached, then `module:update-available` is emitted. The running module is not replaced. It is used at the next launch or after `host.applyUpdate()`.

## Failure reporting

Every non-success path emits exactly one `HostEvent` (see module-api.ts) and appears in `host.report()` with a `reason`. None of them stops other modules or the app.
