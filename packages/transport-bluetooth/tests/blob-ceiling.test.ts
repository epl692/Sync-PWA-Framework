// Spec 005 T096 (US5): large blobs wait for a faster transport; the ceiling is configurable.
import { describe, expect, it } from 'vitest';
import { DEFAULT_BLOB_CEILING_BYTES, blobWaitMessage, bluetoothBlobFilter, createBluetoothTransport, createMemoryTrustStore } from '../src/index';

const MB = 1024 * 1024;

describe('blob ceiling', () => {
  it('defaults to 5 MiB and is a property of the transport so the app can read it', () => {
    expect(DEFAULT_BLOB_CEILING_BYTES).toBe(5 * MB);
    const t = createBluetoothTransport({ proofs: undefined as never, confirmHub: async () => false, trustStore: createMemoryTrustStore() });
    expect(t.blobCeilingBytes).toBe(5 * MB);
    expect(createBluetoothTransport({ proofs: undefined as never, confirmHub: async () => false, trustStore: createMemoryTrustStore(), blobCeilingBytes: 1 * MB }).blobCeilingBytes).toBe(1 * MB);
  });

  it('the filter holds back big blobs over Bluetooth only: 5 MiB goes, 20 MiB waits, any size goes over another transport', () => {
    const f = bluetoothBlobFilter();
    expect(f({ transport: 'bluetooth' }, { size: 5 * MB })).toBe(true);
    expect(f({ transport: 'bluetooth' }, { size: 5 * MB + 1 })).toBe(false);
    expect(f({ transport: 'bluetooth' }, { size: 20 * MB })).toBe(false);
    expect(f({ transport: 'websocket' }, { size: 20 * MB })).toBe(true);
    expect(f({ transport: 'webrtc' }, { size: 500 * MB })).toBe(true);
    expect(bluetoothBlobFilter(1 * MB)({ transport: 'bluetooth' }, { size: 2 * MB })).toBe(false); // configurable per app
  });

  it('tells the user in plain words that a big file will wait, and says nothing for a file that will go', () => {
    expect(blobWaitMessage({ name: 'Camp map.pdf', size: 20 * MB })).toBe('Camp map.pdf (20 MB) is too big to send over Bluetooth (the limit is 5.0 MB). It will download by itself when you are on a faster connection.');
    expect(blobWaitMessage({ name: 'photo.jpg', size: 3 * MB })).toBeUndefined();
    expect(blobWaitMessage({ name: 'photo.jpg', size: 3 * MB, ceilingBytes: 1 * MB })).toMatch(/too big/);
  });
});
