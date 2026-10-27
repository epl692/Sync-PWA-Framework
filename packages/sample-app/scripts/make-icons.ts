// One-off: writes the sample app's icons. Run with `tsx scripts/make-icons.ts`.
import { writeFileSync } from 'node:fs';
import { encodePng } from '../../app-build/src/png';

const blue: [number, number, number, number] = [0x2b, 0x6c, 0xb0, 255];
const white: [number, number, number, number] = [255, 255, 255, 255];

/** A white check mark on blue. `safe` shrinks the mark so a maskable icon survives cropping. */
function icon(size: number, safe: boolean) {
  const s = safe ? 0.6 : 0.8;
  const off = (1 - s) / 2;
  return encodePng(size, size, (x, y) => {
    const u = (x / size - off) / s;
    const v = (y / size - off) / s;
    const onShort = u > 0.0 && u < 0.4 && Math.abs(v - (0.55 + (u - 0.0) * 0.8)) < 0.07;
    const onLong = u >= 0.3 && u < 1.0 && Math.abs(v - (0.95 - (u - 0.3) * 1.25)) < 0.07;
    return onShort || onLong ? white : blue;
  });
}

writeFileSync('public/icons/icon-192.png', icon(192, false));
writeFileSync('public/icons/icon-512.png', icon(512, false));
writeFileSync('public/icons/maskable-512.png', icon(512, true));
console.log('icons written');
