// Writes a sample delivery note for the fictional nursery to the path given, offline:
//
//   node pdf-receipt/examples/write-sample.ts /tmp/remito.pdf [lines]
//
// With a line count above about 20 the document paginates. Warnings are printed as JSON lines.

import { writeFileSync } from 'node:fs';
import { buildReceiptPdf, type ReceiptItem } from '../src/index.ts';

const USAGE = 'usage: node pdf-receipt/examples/write-sample.ts <out.pdf> [lines]';
const [out, linesArg] = process.argv.slice(2);
if (!out) {
  console.error(USAGE);
  process.exit(2);
}
const count = Number(linesArg ?? 4);
// "abc" would give NaN and a receipt with no lines, "2.5" two lines: both with exit 0.
if (!Number.isInteger(count) || count < 1) {
  console.error(`lines must be a whole number of 1 or more\n${USAGE}`);
  process.exit(2);
}
const catalog: ReceiptItem[] = [
  { name: 'Maceta de barro 20 cm', detail: 'x6', quantity: 2, unitPriceCents: 1_250_000 },
  { name: 'Tierra fértil', detail: '50 l', quantity: 3, unitPriceCents: 680_050 },
  { name: 'Helecho serrucho', detail: 'm. 14', quantity: 5, unitPriceCents: 420_000 },
  { name: 'Fertilizante orgánico 🌱', detail: '1 kg', quantity: 1.5, unitPriceCents: 310_000 },
];
const items = Array.from({ length: count }, (_, i) => catalog[i % catalog.length] as ReceiptItem);

const bytes = await buildReceiptPdf(
  {
    number: 'R-0042',
    issuedOn: '2026-11-04',
    shop: { name: 'Vivero Ejemplo', lines: ['Calle de los Ejemplos 123, Ciudad Ejemplo', 'ventas@vivero.example'] },
    customer: { name: 'Jardín de Prueba', lines: ['Pasaje Ficticio 45', 'compras@jardin.example'] },
    deliveryOn: '2026-11-06',
    items,
    shippingCents: 800_050,
    previousBalanceCents: -300_000,
    notes: 'Entregar por el portón lateral.\nRegar las macetas antes de cargarlas.',
    footer: 'Gracias por su compra. El pago se coordina al momento de la entrega.',
  },
  { onWarning: (w) => console.log(JSON.stringify(w)) },
);
writeFileSync(out, bytes);
console.log(`${out}: ${bytes.length} bytes`);
