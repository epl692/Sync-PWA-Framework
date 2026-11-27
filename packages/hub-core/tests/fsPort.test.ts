import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryFs } from '../src/store/fsPort';
import { createNodeFs } from '../src/store/nodeFs';
import { fsPortContract } from './fsPort.contract';

fsPortContract('memory', async () => ({ fs: createMemoryFs(), cleanup: async () => undefined }));
fsPortContract('node fs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hub-fs-'));
  return { fs: createNodeFs(dir), cleanup: () => rm(dir, { recursive: true, force: true }).catch(() => undefined) };
});
