/**
 * Dev tool: generate the PWA icons as PNGs with zero dependencies.
 *
 * The artwork is pure geometry — the character 中 built from a box plus a
 * vertical stroke on the app's accent red, with the 田字格 dashed cross —
 * so no font rasteriser is needed and output is deterministic.
 *
 *   node scripts/gen-icons.ts
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';

const ACCENT = [0xc0, 0x39, 0x2b] as const;
const WHITE = [0xff, 0xff, 0xff] as const;

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** RGBA pixel buffer -> PNG file bytes. */
function encodePng(size: number, rgba: Uint8Array): Uint8Array {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, size);
  view.setUint32(4, size);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  // compression 0, filter 0, interlace 0

  // Raw scanlines, filter byte 0 per row.
  const raw = new Uint8Array(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    raw.set(rgba.subarray(y * size * 4, (y + 1) * size * 4), y * (size * 4 + 1) + 1);
  }

  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(raw))),
    chunk('IEND', new Uint8Array(0)),
  ];
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function drawIcon(size: number, maskable: boolean): Uint8Array {
  const px = new Uint8Array(size * size * 4);
  const cornerRadius = maskable ? 0 : size * 0.18;

  // 中 proportions, tuned for legibility at 192px. The maskable variant
  // shrinks everything into the 80% safe zone.
  const scale = maskable ? 0.8 : 1;
  const cx = size / 2;
  const cy = size / 2;
  const boxHalfW = size * 0.26 * scale;
  const boxHalfH = size * 0.19 * scale;
  const stroke = size * 0.045 * scale;
  const barHalfW = size * 0.045 * scale;
  const barHalfH = size * 0.36 * scale;

  const insideCorner = (x: number, y: number): boolean => {
    if (cornerRadius === 0) return true;
    const r = cornerRadius;
    const nearX = x < r ? r - x : x > size - r ? x - (size - r) : 0;
    const nearY = y < r ? r - y : y > size - r ? y - (size - r) : 0;
    return nearX * nearX + nearY * nearY <= r * r || nearX === 0 || nearY === 0;
  };

  const inGlyph = (x: number, y: number): boolean => {
    const dx = Math.abs(x - cx);
    const dy = Math.abs(y - cy);
    // Vertical stroke of 中.
    if (dx <= barHalfW && dy <= barHalfH) return true;
    // Box (口) outline: inside outer rect but outside inner rect.
    const inOuter = dx <= boxHalfW + stroke && dy <= boxHalfH + stroke;
    const inInner = dx <= boxHalfW - stroke && dy <= boxHalfH - stroke;
    return inOuter && !inInner;
  };

  const onCross = (x: number, y: number): boolean => {
    const inset = size * 0.1;
    const lineWidth = Math.max(1.5, size * 0.006);
    const dash = size * 0.032;
    const gap = size * 0.026;
    const period = dash + gap;
    const horizontal =
      Math.abs(y - cy) <= lineWidth && x >= inset && x <= size - inset && (x - inset) % period < dash;
    const vertical =
      Math.abs(x - cx) <= lineWidth && y >= inset && y <= size - inset && (y - inset) % period < dash;
    return horizontal || vertical;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      if (!insideCorner(x + 0.5, y + 0.5)) {
        px[i + 3] = 0;
        continue;
      }
      let [r, g, b] = ACCENT;
      if (onCross(x + 0.5, y + 0.5)) {
        r = Math.round(r + (255 - r) * 0.25);
        g = Math.round(g + (255 - g) * 0.25);
        b = Math.round(b + (255 - b) * 0.25);
      }
      if (inGlyph(x + 0.5, y + 0.5)) [r, g, b] = WHITE;
      px[i] = r;
      px[i + 1] = g;
      px[i + 2] = b;
      px[i + 3] = 255;
    }
  }
  return px;
}

const outDir = new URL('../public/icons/', import.meta.url);
mkdirSync(outDir, { recursive: true });

const targets: Array<[string, number, boolean]> = [
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['icon-maskable-512.png', 512, true],
  ['apple-touch-icon.png', 180, false],
];

for (const [name, size, maskable] of targets) {
  const png = encodePng(size, drawIcon(size, maskable));
  writeFileSync(new URL(name, outDir), png);
  console.log(`${name}: ${png.length} bytes`);
}
