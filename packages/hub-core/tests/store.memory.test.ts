import { hubStoreContract } from '@sync/testkit';
import { createMemoryStore } from '../src/store/memoryStore';

hubStoreContract('memoryStore', {
  async create() {
    const store = createMemoryStore();
    return { store, reopen: async () => (await store.close(), await store.open(), store), teardown: async () => store.close() };
  },
});
