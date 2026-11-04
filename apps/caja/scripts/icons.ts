// Draws the app icon (a till receipt with the total highlighted) as SVG and as PNG, from one list
// of shapes, with no image library: a point-in-shape test per pixel, 4x4 supersampling, and a PNG
// encoder over node:zlib. Run it after changing the shapes:
//
//   node apps/caja/scripts/icons.ts
//
// Writes icon.svg, icon-192.png, icon-512.png, icon-maskable-512.png and apple-touch-icon.png
// (180 px) into apps/caja/public/. The maskable icon has a square background, and every shape
// sits inside the central 80% circle that launchers keep when they crop.

import { writeFileSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';

type Rgb = readonly [number, number, number];

const INK: Rgb = [0x1c, 0x1b, 0x17];
const PAPER: Rgb = [0xf6, 0xf2, 0xe8];
const HIGHLIGHT: Rgb = [0xf2, 0xc1, 0x4e];

interface Rect { kind: 'rect'; x: number; y: number; w: number; h: number; r: number; fill: Rgb }
interface Poly { kind: 'poly'; points: ReadonlyArray<readonly [number, number]>; fill: Rgb }
type Shape = Rect | Poly;

/** The receipt outline: straight top, torn (zigzag) bottom edge. On a 512 grid. */
function receipt(): Array<[number, number]> {
  const points: Array<[number, number]> = [[136, 96], [376, 96], [376, 400]];
  for (let i = 1; i <= 12; i++) points.push([376 - i * 20, i % 2 === 1 ? 424 : 400]);
  return points;
}

function shapes(maskable: boolean): Shape[] {
  return [
    { kind: 'rect', x: 0, y: 0, w: 512, h: 512, r: maskable ? 0 : 96, fill: INK },
    { kind: 'poly', points: receipt(), fill: PAPER },
    { kind: 'rect', x: 168, y: 150, w: 176, h: 20, r: 4, fill: INK },
    { kind: 'rect', x: 168, y: 200, w: 132, h: 20, r: 4, fill: INK },
    { kind: 'rect', x: 160, y: 262, w: 192, h: 44, r: 6, fill: HIGHLIGHT },
    { kind: 'rect', x: 176, y: 276, w: 160, h: 16, r: 4, fill: INK },
    { kind: 'rect', x: 168, y: 340, w: 92, h: 16, r: 4, fill: INK },
  ];
}

function inRect(s: Rect, x: number, y: number): boolean {
  if (x < s.x || x > s.x + s.w || y < s.y || y > s.y + s.h) return false;
  // Distance to the nearest corner centre, only inside the corner squares.
  const cx = Math.min(Math.max(x, s.x + s.r), s.x + s.w - s.r);
  const cy = Math.min(Math.max(y, s.y + s.r), s.y + s.h - s.r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= s.r ** 2;
}

function inPoly(s: Poly, x: number, y: number): boolean {
  let inside = false;
  const p = s.points;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [xi, yi] = p[i] ?? [0, 0];
    const [xj, yj] = p[j] ?? [0, 0];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const hex = (c: Rgb): string => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;

function svg(list: Shape[]): string {
  const body = list
    .map((s) =>
      s.kind === 'rect'
        ? `<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" rx="${s.r}" fill="${hex(s.fill)}"/>`
        : `<path d="M${s.points.map(([x, y]) => `${x} ${y}`).join('L')}Z" fill="${hex(s.fill)}"/>`,
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
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) * scale;
          const y = (py + (sy + 0.5) / SS) * scale;
          let fill: Rgb | null = null;
          for (const s of list) if (s.kind === 'rect' ? inRect(s, x, y) : inPoly(s, x, y)) fill = s.fill;
          if (fill) {
            r += fill[0]; g += fill[1]; b += fill[2]; a += 255;
          }
        }
      }
      const n = SS * SS;
      const covered = a / 255;
      const o = 1 + px * 4;
      // Colour averaged over covered samples only, so edges do not darken towards black.
      row[o] = covered ? Math.round(r / covered) : 0;
      row[o + 1] = covered ? Math.round(g / covered) : 0;
      row[o + 2] = covered ? Math.round(b / covered) : 0;
      row[o + 3] = Math.round(a / n);
    }
    rows.push(row);
  }
  return png(size, size, Buffer.concat(rows));
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function png(width: number, height: number, scanlines: Buffer): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
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
console.log('icons written to apps/caja/public/');
