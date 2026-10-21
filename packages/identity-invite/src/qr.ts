/** QR codes for invites and device links. Rendering uses `qrcode-generator`; scanning uses the platform BarcodeDetector when there is one. */

import qrcode from 'qrcode-generator';

export type QrEcc = 'L' | 'M' | 'Q' | 'H';

/** The module matrix (true = dark). Throws if the text does not fit a QR code. */
export function qrMatrix(text: string, ecc: QrEcc = 'M'): boolean[][] {
  const qr = qrcode(0, ecc);
  qr.addData(text, 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => qr.isDark(r, c)));
}

/** A self-contained SVG string for the code (with the standard 4-module quiet zone). */
export function qrToSvg(
  text: string,
  opts: { cellSize?: number; margin?: number; ecc?: QrEcc; dark?: string; light?: string } = {},
): string {
  const m = qrMatrix(text, opts.ecc ?? 'M');
  const cell = opts.cellSize ?? 4;
  const margin = opts.margin ?? 4;
  const size = (m.length + margin * 2) * cell;
  let path = '';
  m.forEach((row, r) =>
    row.forEach((on, c) => {
      if (on) path += `M${(c + margin) * cell},${(r + margin) * cell}h${cell}v${cell}h-${cell}z`;
    }),
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" shape-rendering="crispEdges" role="img" aria-label="QR code"><rect width="${size}" height="${size}" fill="${opts.light ?? '#fff'}"/><path d="${path}" fill="${opts.dark ?? '#000'}"/></svg>`;
}

interface BarcodeDetectorLike {
  detect(source: unknown): Promise<Array<{ rawValue: string }>>;
}

function detector(): BarcodeDetectorLike | undefined {
  const Ctor = (globalThis as { BarcodeDetector?: new (o: { formats: string[] }) => BarcodeDetectorLike })
    .BarcodeDetector;
  try {
    return Ctor ? new Ctor({ formats: ['qr_code'] }) : undefined;
  } catch {
    return undefined;
  }
}

/** False where the browser has no BarcodeDetector: show the link or code to paste instead. */
export const canScanQr = (): boolean => detector() !== undefined;

/** Read one QR code from an image, canvas or video frame. Undefined if none is found or scanning is unavailable. */
export async function scanQr(source: unknown): Promise<string | undefined> {
  const d = detector();
  if (!d) return undefined;
  try {
    return (await d.detect(source))[0]?.rawValue;
  } catch {
    return undefined;
  }
}
