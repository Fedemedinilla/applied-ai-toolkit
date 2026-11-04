// Draws the fictional nursery's logo (a leaf on a stem) as a PNG with no image library: a
// point-in-shape test per pixel, 4x4 supersampling and a PNG encoder over node:zlib. The page
// fetches it as bytes and hands them to buildReceiptPdf, the way a serverless function would
// read them from a constant in its bundle. Run it after changing the shapes:
//
//   node apps/receipt/scripts/logo.ts

import { writeFileSync } from 'node:fs';
import { crc32, deflateSync } from 'node:zlib';

const SIZE = 192;
const GREEN = [0x1f, 0x5f, 0x5b] as const;
const SS = 4;

/** A leaf: the intersection of two discs, tilted 45 degrees, plus a stem. On a unit square. */
function inside(x: number, y: number): boolean {
  // Rotate around the centre so the leaf points up and right.
  const cx = x - 0.5;
  const cy = y - 0.5;
  const u = (cx + cy) / Math.SQRT2;
  const v = (cx - cy) / Math.SQRT2;
  const r = 0.42;
  const off = 0.24;
  const leaf = (u - 0) ** 2 + (v - off) ** 2 <= r * r && (u - 0) ** 2 + (v + off) ** 2 <= r * r;
  // The vein, cut out of the leaf along its long axis.
  const vein = Math.abs(v) < 0.018 && u > -0.25 && u < 0.3;
  const stem = Math.abs(v) < 0.03 && u >= -0.44 && u <= -0.25;
  return (leaf && !vein) || stem;
}

function png(): Buffer {
  const rows: Buffer[] = [];
  for (let py = 0; py < SIZE; py++) {
    const row = Buffer.alloc(1 + SIZE * 4);
    for (let px = 0; px < SIZE; px++) {
      let hits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) if (inside((px + (sx + 0.5) / SS) / SIZE, (py + (sy + 0.5) / SS) / SIZE)) hits++;
      }
      row.set([...GREEN, Math.round((255 * hits) / (SS * SS))], 1 + px * 4);
    }
    rows.push(row);
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(SIZE, 0);
  header.writeUInt32BE(SIZE, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const out = new URL('../public/logo-ejemplo.png', import.meta.url);
const bytes = png();
writeFileSync(out, bytes);
console.log(`${out.pathname}: ${bytes.length} bytes`);
