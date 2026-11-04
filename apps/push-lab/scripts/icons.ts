// Draws the app icon (a notification card with a badge dot) as SVG and as PNG, from one list of
// shapes, with no image library: a point-in-shape test per pixel, 4x4 supersampling, and a PNG
// encoder over node:zlib. Run it after changing the shapes:
//
//   node apps/push-lab/scripts/icons.ts
//
// Writes icon.svg, icon-192.png, icon-512.png, icon-maskable-512.png and apple-touch-icon.png
// (180 px) into apps/push-lab/public/. The maskable and Apple icons have a square, opaque
// background (iOS fills transparency with black), and every shape sits inside the central 80%
// circle that launchers keep when they crop.

import { writeFileSync } from 'node:fs';
import { crc32, deflateSync } from 'node:zlib';

type Rgb = readonly [number, number, number];

const GREEN: Rgb = [0x1d, 0x5c, 0x4a];
const CARD: Rgb = [0xf4, 0xf5, 0xf2];
const LINE: Rgb = [0x9f, 0xb8, 0xae];
const SIGNAL: Rgb = [0xe0, 0x5a, 0x1c];

interface Rect { kind: 'rect'; x: number; y: number; w: number; h: number; r: number; fill: Rgb }
interface Circle { kind: 'circle'; cx: number; cy: number; r: number; fill: Rgb }
type Shape = Rect | Circle;

/** On a 512 grid. */
function shapes(square: boolean): Shape[] {
  return [
    { kind: 'rect', x: 0, y: 0, w: 512, h: 512, r: square ? 0 : 108, fill: GREEN },
    { kind: 'rect', x: 112, y: 196, w: 260, h: 144, r: 28, fill: CARD },
    { kind: 'rect', x: 144, y: 236, w: 150, h: 22, r: 11, fill: LINE },
    { kind: 'rect', x: 144, y: 282, w: 104, h: 22, r: 11, fill: LINE },
    { kind: 'circle', cx: 360, cy: 180, r: 58, fill: CARD },
    { kind: 'circle', cx: 360, cy: 180, r: 46, fill: SIGNAL },
  ];
}

function inside(s: Shape, x: number, y: number): boolean {
  if (s.kind === 'circle') return (x - s.cx) ** 2 + (y - s.cy) ** 2 <= s.r ** 2;
  if (x < s.x || x > s.x + s.w || y < s.y || y > s.y + s.h) return false;
  const cx = Math.min(Math.max(x, s.x + s.r), s.x + s.w - s.r);
  const cy = Math.min(Math.max(y, s.y + s.r), s.y + s.h - s.r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= s.r ** 2;
}

const hex = (c: Rgb): string => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;

function svg(list: Shape[]): string {
  const body = list
    .map((s) =>
      s.kind === 'rect'
        ? `<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" rx="${s.r}" fill="${hex(s.fill)}"/>`
        : `<circle cx="${s.cx}" cy="${s.cy}" r="${s.r}" fill="${hex(s.fill)}"/>`,
    )
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${body}</svg>\n`;
}

function raster(list: Shape[], size: number): Buffer {
  const scale = 512 / size;
  const SS = 4;
  const rows: Buffer[] = [];
  for (let py = 0; py < size; py++) {
    const row = Buffer.alloc(1 + size * 4); // filter byte 0, then RGBA
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, covered = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) * scale;
          const y = (py + (sy + 0.5) / SS) * scale;
          let fill: Rgb | null = null;
          for (const s of list) if (inside(s, x, y)) fill = s.fill;
          if (fill) {
            r += fill[0]; g += fill[1]; b += fill[2]; covered++;
          }
        }
      }
      const o = 1 + px * 4;
      // Colour averaged over covered samples only, so edges do not darken towards black.
      row[o] = covered ? Math.round(r / covered) : 0;
      row[o + 1] = covered ? Math.round(g / covered) : 0;
      row[o + 2] = covered ? Math.round(b / covered) : 0;
      row[o + 3] = Math.round((covered * 255) / (SS * SS));
    }
    rows.push(row);
  }
  return png(size, Buffer.concat(rows));
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function png(size: number, scanlines: Buffer): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(scanlines, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const out = (name: string): URL => new URL(`../public/${name}`, import.meta.url);

writeFileSync(out('icon.svg'), svg(shapes(false)));
writeFileSync(out('icon-192.png'), raster(shapes(false), 192));
writeFileSync(out('icon-512.png'), raster(shapes(false), 512));
writeFileSync(out('icon-maskable-512.png'), raster(shapes(true), 512));
writeFileSync(out('apple-touch-icon.png'), raster(shapes(true), 180));
console.log('icons written to apps/push-lab/public/');
