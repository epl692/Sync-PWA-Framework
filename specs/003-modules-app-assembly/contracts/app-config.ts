/**
 * App Config and the build/start API (FR-009, FR-013). `app.config.ts` is ordinary TypeScript
 * that imports its bundled modules; `buildApp` bundles it, so listing a module IS bundling it.
 */

import type { ModuleDefinition, ModuleHost } from './module-api';
import type { JSONValue } from '../../001-sync-core/contracts/public-api';
import type { Spaces } from '../../002-spaces-security-identity/contracts/spaces-api';

export interface AppConfig {
  name: string;
  shortName?: string;
  description?: string;
  /** Hex color for the web manifest and `<meta name="theme-color">`. */
  themeColor: string;
  backgroundColor?: string;
  /** Build input: PNG 192 and 512 are required; a maskable 512 is recommended. Paths relative to the config. */
  icons: { src192: string; src512: string; maskable512?: string };
  /** URL base the app is served under. Default "./" (works at a domain root or any subpath). */
  base?: string;
  /** Bundled modules, in any order; the host sorts by dependencies. */
  modules: readonly ModuleDefinition[];
  /** Per-module settings handed to `ctx.settings`. */
  settings?: Record<string, Record<string, JSONValue>>;
  /** Which registered transports/provider are active, by ID (`<moduleId>.<id>`). Default: none / the first provider. */
  transports?: readonly string[];
  identityProvider?: string;
  runtime?: {
    /** Path of the manifest relative to `base`. `false` disables runtime loading. Default "modules/manifest.json". */
    manifest?: string | false;
    /** Default 2500. Never delays bundled modules. */
    manifestTimeoutMs?: number;
    /** Activation timeout per module. Default 5000. */
    activateTimeoutMs?: number;
    /** Unknown-type deferral window (research R-09). Default 10000. */
    bootWindowMs?: number;
    /**
     * On a very first launch (no cached manifest), wait up to `manifestTimeoutMs` for the manifest so modules listed
     * with `boot: true` can load before the core opens. Default false: bundled modules never wait for the network.
     */
    waitForBoot?: boolean;
  };
  /** Security wiring. Production refuses `'plaintext-for-tests'` (Principle V). */
  security?: 'spaces' | 'plaintext-for-tests';
  /** Extra files copied to the output verbatim and added to the precache. Paths relative to the config. */
  assets?: readonly string[];
  /**
   * Called once after the bundled modules are active. This is where an app signs the user up, creates or
   * selects Spaces, and binds Spaces to modules that declare `bound` access. An error is reported and
   * does not stop the app.
   */
  onReady?(host: ModuleHost, spaces: Spaces): void | Promise<void>;
  /** Extra origins for the CSP `connect-src` (transport servers). Default none: `connect-src` is `'self'` only. */
  connectSrc?: readonly string[];
}

// ---------- runtime ----------

/** Called by the generated entry. Opens the secure core, resolves/activates modules, registers the service worker. */
export declare function startApp(config: AppConfig): Promise<ModuleHost>;

// ---------- build tool (@sync/app-build, Node) ----------

export interface BuildAppOptions {
  /** Path to app.config.ts. */
  config: string;
  outDir: string;
  mode?: 'production' | 'development';
  /** Content hash file names. Default true in production. */
  hash?: boolean;
}

export interface BuildResult {
  outDir: string;
  /** Every emitted file with its SHA-256 revision (the precache list). */
  files: Array<{ path: string; bytes: number; revision: string }>;
  /** Problems that did not stop the build (for example a banned import found in a module). */
  warnings: string[];
}

/**
 * Throws `BuildError` (with every problem listed) when: a module fails `checkSchema` or id/name rules,
 * two bundled modules share an ID, a dependency is unsatisfiable inside the bundle, a module imports
 * a banned `@sync/*` internal (R-10), icons are missing or the wrong size, or production uses a plaintext codec.
 */
export declare function buildApp(opts: BuildAppOptions): Promise<BuildResult>;

export interface BuildModuleOptions {
  /** Entry exporting `default defineModule(...)`. */
  entry: string;
  outFile: string;
  /** Writes the entry for `runtime-manifest.md`: id, version, url, integrity. Returns it. */
  manifestEntry?: { url: string };
}

/**
 * Single-file ESM with no imports (relative or bare). Fails on any import that remains after bundling
 * and on banned `@sync/*` imports. Returns the SHA-256 integrity string.
 */
export declare function buildModule(opts: BuildModuleOptions): Promise<{ integrity: string; id: string; version: string }>;

export interface InstallableReport { ok: boolean; problems: string[] }
/** Static checks: manifest fields, icons, start_url/scope vs base, service worker present with a fetch handler. */
export declare function verifyInstallable(outDir: string): Promise<InstallableReport>;

/** CLI `sync-check-modules <config>`: resolve + checkSchema + collision checks with no browser. Exit code 1 on any problem. */
export declare function checkModules(configPath: string): Promise<string[]>;
