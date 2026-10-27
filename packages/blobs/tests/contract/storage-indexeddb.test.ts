// T029: the IndexedDB BlobStorage (fake-indexeddb) against the shared contract suite.
import 'fake-indexeddb/auto';
import { blobStorageContract } from '@sync/testkit';
import { createIndexedDbBlobStorage } from '../../src/storage';

let n = 0;
blobStorageContract('indexeddb (fake-indexeddb)', {
  async create() {
    const name = `blobs-contract-${++n}-${Math.random()}`;
    const first = await createIndexedDbBlobStorage({ name });
    return { storage: first, reopen: async () => {
      await first.close();
      return createIndexedDbBlobStorage({ name });
    } };
  },
});
