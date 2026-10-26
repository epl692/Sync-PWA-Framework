/** App Config and start options (specs/003-modules-app-assembly/contracts/app-config.ts). Build-only fields live in @sync/app-build. */

import type { JSONValue, StorageAdapter, SyncCore } from '@sync/core';
import type { KeyDb, Spaces } from '@sync/spaces';
import type { ModuleDefinition, ModuleHost } from '../types';

export interface AppConfig {
  name: string;
  shortName?: string;
  description?: string;
  /** Hex color for the web manifest and `<meta name="theme-color">`. */
  themeColor: string;
  backgroundColor?: string;
  /** Build input: PNG 192 and 512 are required; a maskable 512 is recommended. Paths relative to the config. */
  icons: { src192: string; src512: string; maskable512?: string };
  /** URL base the app is served under. Default "./". */
  base?: string;
  /** Bundled modules, in any order; the host sorts by dependencies. */
  modules: readonly ModuleDefinition[];
  /** Per-module settings handed to `ctx.settings`. */
  settings?: Record<string, Record<string, JSONValue>>;
  /** Active transports and identity provider by ID (`<moduleId>.<id>`). Default: no transports / the first provider. */
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
  /** Production refuses `'plaintext-for-tests'` (Principle V). */
  security?: 'spaces' | 'plaintext-for-tests';
  /** Extra files copied to the output verbatim and added to the precache. */
  assets?: readonly string[];
  /** Called once after the bundled modules are active: sign up, create or select Spaces, bind Spaces to modules. Errors are reported, not fatal. */
  onReady?(host: ModuleHost, spaces: Spaces): void | Promise<void>;
  /** Extra origins for the CSP `connect-src` (transport servers). Default none: `'self'` only. */
  connectSrc?: readonly string[];
}

export interface StartOptions {
  /** Default 'production'. Production refuses the plaintext test codec and checks the core with `assertSecureCore`. */
  mode?: 'production' | 'development';
  /** Object store. Default: IndexedDB. */
  storage?: StorageAdapter;
  /** Key database. Default: IndexedDB "sync-keys". */
  keyDb?: KeyDb | string;
  /** A ready core (and Spaces), for tests. Required with `security: 'plaintext-for-tests'`. */
  core?: SyncCore;
  spaces?: Spaces;
  now?: () => number;
  /** Register the generated service worker. Default true; has no effect outside a browser. */
  serviceWorker?: boolean;
  /** Runtime module loading. In a page the defaults apply; tests inject `fetch`, `cache` and `importModule`. */
  runtime?: {
    manifestUrl?: string;
    origin?: string;
    fetch?: typeof fetch;
    cache?: import('../loader/cache').ModuleCache;
    importModule?: (bytes: Uint8Array) => Promise<unknown>;
    integrityOf?: (bytes: Uint8Array) => Promise<string>;
  };
}
