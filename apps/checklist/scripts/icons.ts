// Draws the app icon (three checklist rows on a dark square) as SVG and PNG from one list of shapes,
// with no image library: a distance test per pixel, 4x4 supersampling, and a PNG encoder over
// node:zlib. Run it after changing the shapes:
//
//   node apps/checklist/scripts/icons.ts
//
// Writes icon.svg, icon-192.png, icon-512.png, icon-maskable-512.png and apple-touch-icon.png
// (180 px) into apps/checklist/public/. The maskable icon has a square background and keeps every
// shape inside the central 80% circle that launchers keep when they crop.

import { writeFileSync } from 'node:fs';
import { crc32, deflateSync } from 'node:zlib';

type Rgb = readonly [number, number, number];
const BG: Rgb = [0x1f, 0x3a, 0x5f];
const FG: Rgb = [0xff, 0xff, 0xff];
const DONE: Rgb = [0x6f, 0xd0, 0x8f];

interface Rect { kind: 'rect'; x: number; y: number; w: number; h: number; r: number; fill: Rgb }
/** A line segment with round caps, `width` wide. */
interface Line { kind: 'line'; x1: number; y1: number; x2: number; y2: number; width: number; fill: Rgb }
type Shape = Rect | Line;

const hex = (c: Rgb): string => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;

/** On a 512 grid. Rows at y 160, 256, 352: a check mark for the first two, a bar for each. */
function shapes(maskable: boolean): Shape[] {
  const out: Shape[] = [{ kind: 'rect', x: 0, y: 0, w: 512, h: 512, r: maskable ? 0 : 104, fill: BG }];
  for (const [i, y] of [160, 256, 352].entries()) {
    if (i < 2) {
      out.push({ kind: 'line', x1: 138, y1: y, x2: 160, y2: y + 22, width: 22, fill: DONE });
      out.push({ kind: 'line', x1: 160, y1: y + 22, x2: 204, y2: y - 22, width: 22, fill: DONE });
    } else {
      out.push({ kind: 'rect', x: 140, y: y - 22, w: 52, h: 44, r: 10, fill: FG });
    }
    out.push({ kind: 'rect', x: 232, y: y - 14, w: i === 1 ? 120 : 148, h: 28, r: 14, fill: FG });
  }
  return out;
}

function inside(s: Shape, x: number, y: number): boolean {
  if (s.kind === 'rect') {
    const qx = Math.max(Math.abs(x - (s.x + s.w / 2)) - (s.w / 2 - s.r), 0);
    const qy = Math.max(Math.abs(y - (s.y + s.h / 2)) - (s.h / 2 - s.r), 0);
    return qx * qx + qy * qy <= s.r * s.r;
  }
  const dx = s.x2 - s.x1;
  const dy = s.y2 - s.y1;
  const t = Math.max(0, Math.min(1, ((x - s.x1) * dx + (y - s.y1) * dy) / (dx * dx + dy * dy)));
  const px = s.x1 + t * dx - x;
  const py = s.y1 + t * dy - y;
  return px * px + py * py <= (s.width / 2) ** 2;
}

function svg(): string {
  const body = shapes(false)
    .map((s) =>
      s.kind === 'rect'
        ? `<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" rx="${s.r}" fill="${hex(s.fill)}"/>`
        : `<line x1="${s.x1}" y1="${s.y1}" x2="${s.x2}" y2="${s.y2}" stroke="${hex(s.fill)}" stroke-width="${s.width}" stroke-linecap="round"/>`,
    )
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${body}</svg>\n`;
}

function png(size: number, maskable: boolean): Buffer {
  const list = shapes(maskable);
  // A maskable icon draws the same shapes at 80%, centred, over the full-bleed background.
  const scale = maskable ? 0.8 : 1;
  const offset = (512 - 512 * scale) / 2;
  const rows: Buffer[] = [];
  const S = 4;
  for (let py = 0; py < size; py++) {
    const row = Buffer.alloc(1 + size * 4);
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const gx = ((px + (sx + 0.5) / S) / size) * 512;
          const gy = ((py + (sy + 0.5) / S) / size) * 512;
          let colour: Rgb | null = null;
          for (const [i, s] of list.entries()) {
            const local = i === 0 ? [gx, gy] : [(gx - offset) / scale, (gy - offset) / scale];
            if (inside(s, local[0] ?? 0, local[1] ?? 0)) colour = s.fill;
          }
          if (colour) {
            r += colour[0];
            g += colour[1];
            b += colour[2];
            a += 255;
          }
        }
      }
      const n = S * S;
      const covered = a / 255 || 1;
      row.set([Math.round(r / covered), Math.round(g / covered), Math.round(b / covered), Math.round(a / n)], 1 + px * 4);
    }
    rows.push(row);
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

const out = new URL('../public/', import.meta.url);
writeFileSync(new URL('icon.svg', out), svg());
writeFileSync(new URL('icon-192.png', out), png(192, false));
writeFileSync(new URL('icon-512.png', out), png(512, false));
writeFileSync(new URL('icon-maskable-512.png', out), png(512, true));
writeFileSync(new URL('apple-touch-icon.png', out), png(180, true));
console.log('wrote 5 icons to apps/checklist/public/');
