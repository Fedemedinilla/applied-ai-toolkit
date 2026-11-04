// Page breaks found from the outside: the tests search for the row count at which something moves
// to page 2, then check what each page holds at that boundary and one row either side.

import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { buildReceiptPdf, type ReceiptData } from '../src/index.ts';
import { LAYOUT } from '../src/receipt.ts';
import { items, order } from './helpers/fixtures.ts';
import { pageCount, record, type Drawn } from './helpers/record.ts';

const A4 = { width: 595.28, height: 841.89 };

async function layout(data: ReceiptData): Promise<{ drawn: Drawn[]; pages: number }> {
  const { result, drawn } = await record(() => buildReceiptPdf(data));
  const pages = (await PDFDocument.load(result)).getPageCount();
  expect(pageCount(drawn)).toBe(pages);
  return { drawn, pages };
}

const onPage = (drawn: readonly Drawn[], page: number): string[] => drawn.filter((d) => d.page === page).map((d) => d.text);
const pageOf = (drawn: readonly Drawn[], text: string): number | undefined => drawn.find((d) => d.text === text)?.page;

/** The smallest n in 1..max for which `moved` holds. */
async function boundary(make: (n: number) => ReceiptData, moved: (drawn: Drawn[]) => boolean, max = 80): Promise<number> {
  for (let n = 1; n <= max; n++) if (moved((await layout(make(n))).drawn)) return n;
  throw new Error('no boundary found');
}

const plain = (n: number) => order({ items: items(n), deliveryOn: null });

describe('page breaks in the item table', () => {
  it('moves the totals alone to page 2 first, without a table head there', async () => {
    const n = await boundary(plain, (d) => pageOf(d, 'Total') === 1);
    const before = await layout(plain(n - 1));
    expect(before.pages).toBe(1);

    const at = await layout(plain(n));
    expect(at.pages).toBe(2);
    expect(pageOf(at.drawn, `Maceta ${n}`)).toBe(0);
    const page2 = onPage(at.drawn, 1);
    expect(page2).toContain('Total');
    expect(page2).not.toContain('Producto');
    expect(page2).toContain('REMITO R-0042 · continuación');
  });

  it('moves a row to page 2 under a repeated table head', async () => {
    const totalsMove = await boundary(plain, (d) => pageOf(d, 'Total') === 1);
    const n = await boundary(plain, (d) => d.some((x) => x.page === 1 && x.text.startsWith('Maceta')));
    expect(n).toBeGreaterThan(totalsMove);
    const before = await layout(plain(n - 1));
    expect(pageOf(before.drawn, `Maceta ${n - 1}`)).toBe(0);

    const at = await layout(plain(n));
    const head = at.drawn.find((d) => d.page === 1 && d.text === 'Producto');
    const row = at.drawn.find((d) => d.text === `Maceta ${n}`);
    expect(row?.page).toBe(1);
    expect(head).toBeDefined();
    expect((head?.y ?? 0) - (row?.y ?? 0)).toBe(25);
    expect(onPage(at.drawn, 1).filter((t) => t.startsWith('Maceta'))).toEqual([`Maceta ${n}`]);
  });

  it('reserves room only for the extras that are drawn', async () => {
    const withExtras = (n: number) => order({ items: items(n), deliveryOn: null, shippingCents: 100, previousBalanceCents: 100 });
    const plainMove = await boundary(plain, (d) => pageOf(d, 'Total') === 1);
    const extrasMove = await boundary(withExtras, (d) => pageOf(d, 'Total del pedido') === 1);
    expect(extrasMove).toBeLessThan(plainMove);
  });

  it('fits the same number of rows on every full continuation page, more than on page 1', async () => {
    const { drawn, pages } = await layout(plain(200));
    const rows = Array.from({ length: pages }, (_, p) => onPage(drawn, p).filter((t) => t.startsWith('Maceta')).length);
    const full = rows.slice(1, -1);
    expect(new Set(full).size).toBe(1);
    expect(full[0]).toBeGreaterThan(rows[0] ?? 0);
    expect(rows.reduce((a, b) => a + b, 0)).toBe(200);
  });

  it('counts a wrapped name as a taller row', async () => {
    const tall = (n: number) =>
      order({ deliveryOn: null, items: items(n).map((it) => ({ ...it, name: `${it.name} ${'con nombre largo '.repeat(8)}` })) });
    const oneLine = await boundary(plain, (d) => d.some((x) => x.page === 1 && x.text.startsWith('Maceta')));
    const threeLines = await boundary(tall, (d) => d.some((x) => x.page === 1 && x.text.startsWith('Maceta')));
    expect(threeLines).toBeLessThan(oneLine);
  });
});

describe('notes across pages', () => {
  it('continue in a second box with a continuation heading, every line once and in order', async () => {
    const paragraphs = Array.from({ length: 120 }, (_, i) => `Nota ${i + 1}`);
    const { drawn, pages } = await layout(order({ notes: paragraphs.join('\n') }));
    expect(pages).toBeGreaterThan(2);
    const notes = drawn.filter((d) => d.text.startsWith('Nota '));
    expect(notes.map((d) => d.text)).toEqual(paragraphs);
    expect(drawn.filter((d) => d.text === 'Aclaraciones')).toHaveLength(1);
    expect(drawn.filter((d) => d.text === 'Aclaraciones (continuación)').map((d) => d.page)).toEqual(
      Array.from({ length: pages - 1 }, (_, i) => i + 1),
    );
  });

  it('wrap 10,000 characters of notes over as many pages as they take', async () => {
    const { drawn, pages } = await layout(order({ notes: 'regar dos veces por semana '.repeat(370) }));
    expect(pages).toBeGreaterThan(1);
    const words = drawn.filter((d) => d.text.startsWith('regar') || d.text.startsWith('dos') || d.text.startsWith('veces') || d.text.startsWith('por') || d.text.startsWith('semana'));
    expect(words.map((d) => d.text).join(' ').split(' ').filter((w) => w === 'regar')).toHaveLength(370);
  });
});

describe('every page', () => {
  it('keeps the tallest allowed rows above the footer zone', async () => {
    const name = 'palabra '.repeat(400);
    const { result, drawn } = await record(() =>
      buildReceiptPdf(order({ items: Array.from({ length: 6 }, () => ({ name, quantity: 1, unitPriceCents: 1 })) }), { maxNameLines: 20 }),
    );
    expect((await PDFDocument.load(result)).getPageCount()).toBeGreaterThan(1);
    const rows = drawn.filter((d) => d.text.startsWith('palabra'));
    expect(rows).toHaveLength(120);
    for (const d of rows) expect(d.y).toBeGreaterThanOrEqual(LAYOUT.contentBottom);
  });

  it('keeps content above the footer zone and inside the margins, with the footer on each page', async () => {
    const { drawn, pages } = await layout(
      order({ items: items(90), shippingCents: 100, previousBalanceCents: -100, notes: 'nota larga '.repeat(600), footer: 'Gracias por su compra' }),
    );
    const footerYs = new Set<number>([LAYOUT.footerTextY, LAYOUT.footerSmallY]);
    for (const d of drawn) {
      if (footerYs.has(d.y)) continue;
      expect(d.y, d.text).toBeGreaterThanOrEqual(LAYOUT.contentBottom);
      expect(d.y, d.text).toBeLessThan(A4.height);
      expect(d.x, d.text).toBeGreaterThanOrEqual(LAYOUT.margin - 0.01);
      expect(d.x + d.width, d.text).toBeLessThanOrEqual(A4.width - LAYOUT.margin + 0.01);
    }
    for (let p = 0; p < pages; p++) {
      expect(onPage(drawn, p)).toContain(`Página ${p + 1} de ${pages}`);
      expect(onPage(drawn, p)).toContain('Gracias por su compra');
    }
  });
});
