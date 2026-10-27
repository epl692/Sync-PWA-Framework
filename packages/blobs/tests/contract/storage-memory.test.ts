// T028: the in-memory BlobStorage against the shared contract suite.
import { blobStorageContract } from '@sync/testkit';
import { createMemoryBlobStorage } from '../../src/storage';

blobStorageContract('memory', {
  async create() {
    const storage = createMemoryBlobStorage();
    return { storage, setQuota: (b) => storage.setQuota(b) };
  },
});
