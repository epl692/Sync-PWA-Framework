#!/usr/bin/env tsx
/** sync-app-build CLI:  build <config> <outDir> [--dev] | check-modules <config> | verify-installable <dir> */

import { BuildError, buildApp } from './build-app';
import { checkModules } from './check-modules';
import { verifyInstallable } from './installable';

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const args = rest.filter((a) => !a.startsWith('--'));
  const flags = new Set(rest.filter((a) => a.startsWith('--')));
  switch (cmd) {
    case 'build': {
      const [config, outDir] = args;
      if (!config || !outDir) return usage();
      try {
        const r = await buildApp({ config, outDir, mode: flags.has('--dev') ? 'development' : 'production' });
        console.log(`built ${r.files.length} files into ${r.outDir}`);
        for (const w of r.warnings) console.warn(`warning: ${w}`);
        return 0;
      } catch (e) {
        if (e instanceof BuildError) {
          console.error(e.message);
          return 1;
        }
        throw e;
      }
    }
    case 'check-modules': {
      if (!args[0]) return usage();
      const problems = await checkModules(args[0]);
      if (!problems.length) {
        console.log('ok');
        return 0;
      }
      for (const p of problems) console.error(`- ${p}`);
      return 1;
    }
    case 'verify-installable': {
      if (!args[0]) return usage();
      const r = await verifyInstallable(args[0]);
      if (r.ok) {
        console.log('ok');
        return 0;
      }
      for (const p of r.problems) console.error(`- ${p}`);
      return 1;
    }
    default:
      return usage();
  }
}

function usage(): number {
  console.error('usage: cli.ts build <config> <outDir> [--dev] | check-modules <config> | verify-installable <dir>');
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    console.error(e instanceof Error ? e.stack : e);
    process.exit(1);
  },
);
