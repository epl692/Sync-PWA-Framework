import 'fake-indexeddb/auto';
import { storageContract } from '@sync/testkit';
import { createIndexedDbStorage } from '../../src/storage/indexeddb';

let n = 0;
// A fresh database name per test keeps tests isolated.
storageContract('indexeddb (fake-indexeddb)', () => createIndexedDbStorage({ name: `contract-${++n}-${Math.random()}` }));
