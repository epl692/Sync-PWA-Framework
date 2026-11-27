/** Blob policy for a slow link (research R-05): large blobs wait for a faster transport instead of crawling over Bluetooth. */

export const DEFAULT_BLOB_CEILING_BYTES = 5 * 1024 * 1024;

/**
 * Pass as `sourceFilter` in the blob engine's config. A peer reached over Bluetooth may serve a blob only up to `ceilingBytes`;
 * every other transport serves any size. A larger blob simply waits, and transfers by itself once another transport is connected.
 */
export function bluetoothBlobFilter(ceilingBytes = DEFAULT_BLOB_CEILING_BYTES): (peer: { transport: string }, ref: { size: number }) => boolean {
  return (peer, ref) => peer.transport !== 'bluetooth' || ref.size <= ceilingBytes;
}

const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(n >= 10 * 1024 * 1024 ? 0 : 1)} MB`;

/** What to tell the user about a blob that will not go over Bluetooth, or undefined if it will. */
export function blobWaitMessage(a: { name: string; size: number; ceilingBytes?: number }): string | undefined {
  const ceiling = a.ceilingBytes ?? DEFAULT_BLOB_CEILING_BYTES;
  if (a.size <= ceiling) return undefined;
  return `${a.name} (${mb(a.size)}) is too big to send over Bluetooth (the limit is ${mb(ceiling)}). It will download by itself when you are on a faster connection.`;
}
