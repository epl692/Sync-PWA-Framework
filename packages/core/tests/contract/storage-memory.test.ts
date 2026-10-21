import { storageContract } from '@sync/testkit';
import { createMemoryStorage } from '../../src/storage/memory';

storageContract('memory', () => createMemoryStorage(), {
  makeQuotaLimited: () => createMemoryStorage({ quotaBytes: 1024 }),
});
