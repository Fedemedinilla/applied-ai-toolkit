// Draws the app icon (a die showing five, the centre pip in the accent colour) as SVG and as PNG,
// from one list of shapes, with no image library: a point-in-shape test per pixel, 4x4
// supersampling, and a PNG encoder over node:zlib. Run it after changing the shapes:
//
//   node apps/replay-lab/scripts/icons.ts
//
// Writes icon.svg, icon-192.png, icon-512.png, icon-maskable-512.png and apple-touch-icon.png
// (180 px) into apps/replay-lab/public/. The maskable icon has a square background, and every
// shape sits inside the central 80% circle that launchers keep when they crop.

import { writeFileSync } from 'node:fs';
import { crc32, deflateSync } from 'node:zlib';

type Rgb = readonly [number, number, number];

const INK: Rgb = [0x14, 0x20, 0x1d];
const PAPER: Rgb = [0xf3, 0xf5, 0xf4];
const ACCENT: Rgb = [0x5f, 0xc4, 0xae];

interface Rect { kind: 'rect'; x: number; y: number; w: number; h: number; r: number; fill: Rgb }
interface Circle { kind: 'circle'; cx: number; cy: number; r: number; fill: Rgb }
type Shape = Rect | Circle;

function shapes(maskable: boolean): Shape[] {
  const pip = (cx: number, cy: number, fill: Rgb): Circle => ({ kind: 'circle', cx, cy, r: 30, fill });
  return [
    { kind: 'rect', x: 0, y: 0, w: 512, h: 512, r: maskable ? 0 : 96, fill: INK },
    { kind: 'rect', x: 136, y: 136, w: 240, h: 240, r: 48, fill: PAPER },
    pip(200, 200, INK),
    pip(312, 200, INK),
    pip(256, 256, ACCENT),
    pip(200, 312, INK),
    pip(312, 312, INK),
  ];
}

function inside(s: Shape, x: number, y: number): boolean {
  if (s.kind === 'circle') return (x - s.cx) * (x - s.cx) + (y - s.cy) * (y - s.cy) <= s.r * s.r;
  if (x < s.x || x > s.x + s.w || y < s.y || y > s.y + s.h) return false;
  const cx = Math.min(Math.max(x, s.x + s.r), s.x + s.w - s.r);
  const cy = Math.min(Math.max(y, s.y + s.r), s.y + s.h - s.r);
  return (x - cx) * (x - cx) + (y - cy) * (y - cy) <= s.r * s.r;
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

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function raster(list: Shape[], size: number): Buffer {
  const scale = 512 / size;
  const SS = 4;
  const rows: Buffer[] = [];
  for (let py = 0; py < size; py++) {
    const row = Buffer.alloc(1 + size * 4);
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let covered = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) * scale;
          const y = (py + (sy + 0.5) / SS) * scale;
          let fill: Rgb | null = null;
          for (const s of list) if (inside(s, x, y)) fill = s.fill;
          if (fill) {
            r += fill[0];
            g += fill[1];
            b += fill[2];
            covered += 1;
          }
        }
      }
      const o = 1 + px * 4;
      row[o] = covered ? Math.round(r / covered) : 0;
      row[o + 1] = covered ? Math.round(g / covered) : 0;
      row[o + 2] = covered ? Math.round(b / covered) : 0;
      row[o + 3] = Math.round((covered * 255) / (SS * SS));
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const out = (name: string): URL => new URL(`../public/${name}`, import.meta.url);

writeFileSync(out('icon.svg'), svg(shapes(false)));
writeFileSync(out('icon-192.png'), raster(shapes(false), 192));
writeFileSync(out('icon-512.png'), raster(shapes(false), 512));
writeFileSync(out('icon-maskable-512.png'), raster(shapes(true), 512));
writeFileSync(out('apple-touch-icon.png'), raster(shapes(true), 180));
console.log('icons written to apps/replay-lab/public/');
