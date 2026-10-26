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
  // First launch: a user and a Space to write to. Space bindings for `bound` modules are added with US5 (T091).
  async onReady(_host, spaces) {
    if (!spaces.session()) await spaces.signUp('Me');
    if (!(await spaces.list()).length) await spaces.create('Personal');
    mountShell();
  },
} satisfies AppConfig;
