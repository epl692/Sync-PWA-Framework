/** Just enough PNG to check icon sizes and to generate simple icons. No dependency. */

import { deflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Width and height from the IHDR chunk, or undefined if the bytes are not a PNG. */
export function readPngSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.length < 24 || !b.subarray(0, 8).equals(SIGNATURE) || b.toString('ascii', 12, 16) !== 'IHDR') return undefined;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** An RGBA PNG; `pixel(x, y)` returns [r, g, b, a] (0-255). */
export function encodePng(width: number, height: number, pixel: (x: number, y: number) => [number, number, number, number]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const rows = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const o = y * (1 + width * 4);
    rows[o] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixel(x, y);
      rows.set([r, g, b, a], o + 1 + x * 4);
    }
  }
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
