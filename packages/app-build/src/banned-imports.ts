/** Keeps module code away from framework internals (research R-10). Defense in depth, not a sandbox. */

import type { Plugin } from 'esbuild';
import { relative } from 'node:path';

/** The framework's own sources (in this monorepo; installed copies live under node_modules). */
const FRAMEWORK_SRC = /[\\/]packages[\\/](?:core|spaces|modules|blobs|testkit|identity-invite|transport-[a-z]+|relay-server|app-build)[\\/]src[\\/]/;

/** An app may use `@sync/modules` and the infrastructure packages (transports, identity providers), but not the core itself. */
export const bannedForApp = (spec: string): boolean => /^@sync\/(?:core|spaces|testkit|relay-server|app-build)(?:\/|$)/.test(spec);

/** A runtime module is one self-contained file: any `@sync/*` value import would copy the framework into it. */
/** (`@sync/modules/migrate` is the exception: migration helpers, about 1 KB, no dependencies.) */
export const bannedForRuntimeModule = (spec: string): boolean => spec.startsWith('@sync/') && spec !== '@sync/modules/migrate';

/**
 * An esbuild plugin that notes every banned import made by the app's own files while resolving, and keeps the build
 * going (the import is marked external) so every problem is reported, not just the first resolution failure.
 * Type-only imports never get here: esbuild erases them before resolving.
 */
export function bannedImportsPlugin(o: { banned(spec: string): boolean; because: string; cwd?: string }): { plugin: Plugin; problems: string[] } {
  const problems: string[] = [];
  const cwd = o.cwd ?? process.cwd();
  const plugin: Plugin = {
    name: 'sync-banned-imports',
    setup(b) {
      b.onResolve({ filter: /^@sync\// }, (args) => {
        if (args.namespace !== 'file' || args.importer.includes('node_modules') || FRAMEWORK_SRC.test(args.importer)) return undefined;
        if (!o.banned(args.path)) return undefined;
        const msg = `${relative(cwd, args.importer)}: imports "${args.path}"; ${o.because}`;
        if (!problems.includes(msg)) problems.push(msg);
        return { path: args.path, external: true };
      });
    },
  };
  return { plugin, problems };
}
