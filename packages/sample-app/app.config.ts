import { createBlobs, defineSyncBlob } from '@sync/blobs';
import type { AppConfig } from '@sync/modules';
import identity from './infra/identity/index';
import stats from './modules/stats/index';
import todo from './modules/todo/index';
import { mountShell } from './shell';

export default {
  name: 'Sample Todo',
  shortName: 'Todo',
  description: 'Sample app built from two bundled modules and one runtime module',
  themeColor: '#2b6cb0',
  icons: { src192: 'public/icons/icon-192.png', src512: 'public/icons/icon-512.png', maskable512: 'public/icons/maskable-512.png' },
  modules: [identity, todo, stats],
  identityProvider: 'identity.invite',
  // Attachments: the todo items can carry a photo, shown with <sync-blob>. This is app code, so it may import the blobs package.
  async blobs({ core, spaces }) {
    const blobs = await createBlobs({ core, keys: spaces!.blobKeys });
    defineSyncBlob(blobs);
    return blobs;
  },
  // First launch: a user and a Space to write to. Modules use `bound` Space access by default, so the app says
  // which Space each one may use on this device (a device setting that persists).
  async onReady(host, spaces) {
    if (!spaces.session()) await spaces.signUp('Me');
    const personal = (await spaces.list())[0] ?? (await spaces.create('Personal'));
    await host.bindSpace('todo', personal.id, 'rw');
    await host.bindSpace('stats', personal.id, 'r');
    await host.bindSpace('notes', personal.id, 'rw'); // a runtime module: the binding is made before it loads
    mountShell();
  },
} satisfies AppConfig;
