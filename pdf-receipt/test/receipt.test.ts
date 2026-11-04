// What reaches the paper, checked by recording every drawText call (helpers/record.ts): which
// amounts, in what order, at what size and where. The expected texts are written out whole.

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { PDFDocument, PDFPage } from 'pdf-lib';
import { buildReceipt, buildReceiptPdf, LABELS_EN, MAX_CENTS, type ReceiptData, type ReceiptOptions, type ReceiptWarning } from '../src/index.ts';
import { columns, LAYOUT } from '../src/receipt.ts';
import { items, order } from './helpers/fixtures.ts';
import { solidPng } from './helpers/png.ts';
import { amounts, pageCount, record, texts, type Drawn } from './helpers/record.ts';

const A4_WIDTH = 595.28;
const col = columns(A4_WIDTH);
const EPS = 0.01;

async function drawnOf(data: ReceiptData, options: ReceiptOptions = {}): Promise<Drawn[]> {
  return (await record(() => buildReceiptPdf(data, options))).drawn;
}

const find = (drawn: readonly Drawn[], text: string): Drawn => {
  const d = drawn.filter((x) => x.text === text).pop();
  if (!d) throw new Error(`"${text}" was not drawn; drawn: ${texts(drawn)}`);
  return d;
};

describe('the amounts on the paper', () => {
  it('prints whole amounts with no decimals, in reading order', async () => {
    const drawn = await drawnOf(order({ shippingCents: 800_000, previousBalanceCents: -300_000 }));
    expect(texts(amounts(drawn))).toBe('$9.000 | $27.000 | $9.000 | $18.000 | $45.000 | $8.000 | $53.000 | $3.000');
    expect(find(drawn, '$53.000').size).toBe(15);
    expect(find(drawn, '$45.000').size).toBe(12);
  });

  it('prints cents with exactly two decimals everywhere', async () => {
    const drawn = await drawnOf(
      order({
        items: [{ name: 'Helecho', quantity: 2, unitPriceCents: 185_180 }],
        shippingCents: 800_050,
        previousBalanceCents: 125_025,
      }),
    );
    expect(texts(amounts(drawn))).toBe('$1.851,80 | $3.703,60 | $3.703,60 | $8.000,50 | $11.704,10 | $1.250,25');
  });

  it('labels a negative balance as a credit and prints it without the sign, below the totals', async () => {
    const drawn = await drawnOf(order({ previousBalanceCents: -300_000 }));
    const label = find(drawn, 'Saldo a favor');
    const total = find(drawn, '$45.000');
    expect(find(drawn, '$3.000').y).toBe(label.y);
    expect(label.y).toBeLessThan(total.y);
    expect(find(drawn, '(no incluido en el total)').y).toBeLessThan(label.y);
    expect(drawn.some((d) => d.text.includes('-$3.000'))).toBe(false);
  });

  it('never adds the previous balance to the total', async () => {
    const drawn = await drawnOf(order({ shippingCents: 100_000, previousBalanceCents: 500_000 }));
    expect(find(drawn, 'TOTAL FINAL')).toBeDefined();
    expect(texts(amounts(drawn))).toContain('$46.000 | $5.000');
  });

  it('prints a shipping of $0 but no grand total, and nothing for absent extras', async () => {
    const free = await drawnOf(order({ shippingCents: 0 }));
    expect(texts(amounts(free))).toBe('$9.000 | $27.000 | $9.000 | $18.000 | $45.000 | $0');
    expect(free.some((d) => d.text === 'TOTAL FINAL')).toBe(false);
    expect(find(free, 'Total').size).toBe(12);
    expect(find(free, '$45.000').size).toBe(15);

    const none = await drawnOf(order({ shippingCents: null, previousBalanceCents: 0 }));
    expect(texts(amounts(none))).toBe('$9.000 | $27.000 | $9.000 | $18.000 | $45.000');
    expect(none.some((d) => /Envío|Saldo/.test(d.text))).toBe(false);
  });
});

describe('adaptive size: an amount never runs over its label', () => {
  const totalsZoneLeft = col.unitPriceRight + LAYOUT.amountGap;

  it('shrinks a grand total with cents that is wider than its gap', async () => {
    const drawn = await drawnOf(order({ items: [{ name: 'Pedido grande', quantity: 1, unitPriceCents: 14_000_000 }], shippingCents: 800_050 }));
    const total = find(drawn, '$148.000,50');
    const label = find(drawn, 'TOTAL FINAL');
    expect(total.size).toBeLessThan(15);
    expect(total.x).toBeGreaterThanOrEqual(totalsZoneLeft - EPS);
    expect(total.x + total.width).toBeCloseTo(col.lineTotalRight, 6);
    expect(label.x + label.width).toBeLessThanOrEqual(total.x - LAYOUT.amountGap + EPS);
  });

  it('shrinks a total without shipping, and only the total', async () => {
    const drawn = await drawnOf(order({ items: [{ name: 'Pedido grande', quantity: 1, unitPriceCents: 12_345_650 }] }));
    const all = drawn.filter((d) => d.text === '$123.456,50');
    expect(all).toHaveLength(3); // unit price, line total, total
    const total = all[2];
    expect(total?.size).toBeLessThan(15);
    expect(total?.x).toBeGreaterThanOrEqual(totalsZoneLeft - EPS);
  });

  it('keeps 15 pt for a whole total that fits', async () => {
    const drawn = await drawnOf(order({ items: [{ name: 'Pedido grande', quantity: 1, unitPriceCents: 123_456_700 }] }));
    expect(find(drawn, '$1.234.567').size).toBe(15);
  });

  it('keeps every amount inside its column at the largest values', async () => {
    const big = order({
      items: [{ name: 'Invernadero', quantity: 1, unitPriceCents: MAX_CENTS - 1_000_000 }, { name: 'Kilos', quantity: 999_999.999, unitPriceCents: 1 }],
      shippingCents: 0,
      previousBalanceCents: -MAX_CENTS,
    });
    const drawn = await drawnOf(big);
    const zones: Array<[number, number]> = [
      [col.quantityRight - col.quantityWidth, col.quantityRight],
      [col.unitPriceRight - col.unitPriceWidth, col.unitPriceRight],
      [col.lineTotalRight - col.totalsAmountWidth, col.lineTotalRight],
    ];
    const numeric = drawn.filter((d) => /^-?\$|^[\d.,]+$/.test(d.text));
    expect(numeric.length).toBeGreaterThanOrEqual(8);
    for (const d of numeric) {
      const zone = zones.find(([, r]) => Math.abs(d.x + d.width - r) < EPS);
      expect(zone, `${d.text} is right-aligned to a column`).toBeDefined();
      expect(d.x, d.text).toBeGreaterThanOrEqual((zone?.[0] ?? 0) - EPS);
    }
    expect(find(drawn, '$99.999.999.999,99').size).toBeLessThan(10);
  });
});

describe('hostile text', () => {
  it('builds with emoji, CJK, RTL, zero-width and combining characters in every field', async () => {
    const warnings: ReceiptWarning[] = [];
    const hostile = order({
      number: 'R-😀-0099',
      shop: { name: 'Vivero 🌿 Ejemplo', lines: ['Calle ★ 123', 'ventas@vivero.example 🙏'] },
      customer: { name: 'Café “La Estrella” ★ 😀 Ñandú', lines: ['\u202Eטקסט', 'Dirección: Av. 中文 12'] },
      items: [
        { name: 'Maceta 🍓 de barro', detail: 'x6 ✓', quantity: 3, unitPriceCents: 900_000 },
        { name: 'Pavlova —edición— 中文', detail: 'ب', quantity: 2, unitPriceCents: 900_000 },
        { name: 'Ma\u200Bce\u200Dta\u2060 cafe\u0301', quantity: 1, unitPriceCents: 1 },
        { name: '😀😀😀', quantity: 1, unitPriceCents: 1 },
      ],
      notes: 'Sin 🥜 (alergia)\nTocar timbre B ✓\r\n\u202Bمرحبا\u202C fin',
      footer: 'Gracias 🙌',
    });
    const { result, drawn } = await record(() => buildReceiptPdf(hostile, { onWarning: (w) => warnings.push(w) }));
    expect(new TextDecoder().decode(result.subarray(0, 5))).toBe('%PDF-');
    expect(drawn.map((d) => d.text)).toEqual(expect.arrayContaining([
      'R--0099',
      'Café “La Estrella” Ñandú',
      'Maceta de barro',
      'Pavlova —edición—',
      'Maceta café',
      '(texto no imprimible)',
      'Sin (alergia)',
      'Tocar timbre B',
      'fin',
    ]));
    expect(warnings.filter((w) => w.code === 'characters_dropped').length).toBeGreaterThanOrEqual(10);
  });

  it('wraps a 10,000-character product name to three lines inside its column', async () => {
    const warnings: ReceiptWarning[] = [];
    const long = 'Maceta ' + 'muy '.repeat(2500);
    const drawn = await drawnOf(order({ items: [{ name: long, quantity: 1, unitPriceCents: 100 }, { name: 'x'.repeat(10_000), quantity: 1, unitPriceCents: 100 }] }), {
      onWarning: (w) => warnings.push(w),
    });
    const nameLines = drawn.filter((d) => d.x === col.nameLeft && d.size === 10 && /^(Maceta|muy|x)/.test(d.text));
    expect(nameLines).toHaveLength(6);
    for (const d of nameLines) expect(d.width).toBeLessThanOrEqual(col.nameWidth + EPS);
    expect(nameLines[2]?.text.endsWith('…')).toBe(true);
    expect(nameLines[5]?.text.endsWith('…')).toBe(true);
    expect(warnings).toEqual(expect.arrayContaining([
      { code: 'text_clipped', field: 'items[0].name' },
      { code: 'text_clipped', field: 'items[1].name' },
    ]));
  });

  it('builds 500 lines, with every line total drawn once', async () => {
    const many = order({ items: items(500, 123_45) });
    const t0 = performance.now();
    const { result, drawn } = await record(() => buildReceiptPdf(many));
    expect(performance.now() - t0).toBeLessThan(5000);
    const pages = (await PDFDocument.load(result)).getPageCount();
    expect(pageCount(drawn)).toBe(pages);
    expect(pages).toBeGreaterThan(15);
    for (let i = 1; i <= 500; i++) expect(drawn.filter((d) => d.text === `Maceta ${i}`)).toHaveLength(1);
    expect(find(drawn, '$61.725').size).toBe(15);
  });

  it('never throws for any text in any field (fast-check over all of Unicode)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.string({ unit: 'binary', maxLength: 300 }), { minLength: 6, maxLength: 6 }),
        async ([a = '', b = '', c = '', d = '', e = '', f = '']) => {
          const bytes = await buildReceiptPdf(
            order({ number: a, shop: { name: b, lines: [c] }, customer: { name: c, lines: [d] }, items: [{ name: d, detail: e, quantity: 1, unitPriceCents: 1 }], notes: e, footer: f }),
            { labels: { title: f, total: a } },
          );
          expect(bytes.length).toBeGreaterThan(1000);
        },
      ),
      { numRuns: 40 },
    );
  });
});

describe('logo', () => {
  it('embeds PNG bytes, from a Uint8Array or an ArrayBuffer', async () => {
    const png = solidPng(120, 40, [31, 95, 91, 255]);
    for (const logo of [png, png.slice().buffer]) {
      const calls: unknown[] = [];
      const real = PDFPage.prototype.drawImage;
      PDFPage.prototype.drawImage = function (this: PDFPage, ...args: Parameters<PDFPage['drawImage']>) {
        calls.push(args[1]);
        real.apply(this, args);
      };
      try {
        const warnings: ReceiptWarning[] = [];
        const drawn = await drawnOf(order(), { logo, onWarning: (w) => warnings.push(w) });
        expect(warnings).toEqual([]);
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ width: 120 * (44 / 40), height: 44 });
        expect(drawn.filter((d) => d.text === 'Vivero Ejemplo').map((d) => d.size)).toEqual([12, 8]);
      } finally {
        PDFPage.prototype.drawImage = real;
      }
    }
  });

  it('falls back to the shop name, with a warning, for bytes that are not an image or a broken PNG', async () => {
    for (const [logo, reason] of [
      [new TextEncoder().encode('<svg/>'), 'unknown_format'],
      [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]), 'embed_failed'],
    ] as const) {
      const warnings: ReceiptWarning[] = [];
      const drawn = await drawnOf(order(), { logo, onWarning: (w) => warnings.push(w) });
      expect(warnings).toEqual([{ code: 'logo_unreadable', reason }]);
      expect(drawn.filter((d) => d.text === 'Vivero Ejemplo').map((d) => d.size)).toContain(20);
    }
  });
});

describe('document', () => {
  it('gives the same bytes for the same input, whatever the clock says', async () => {
    const a = await buildReceiptPdf(order({ notes: 'uno' }), { logo: solidPng(4, 4, [0, 0, 0, 255]) });
    await new Promise((r) => setTimeout(r, 1100));
    const b = await buildReceiptPdf(order({ notes: 'uno' }), { logo: solidPng(4, 4, [0, 0, 0, 255]) });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    const doc = await PDFDocument.load(a);
    expect(doc.getTitle()).toBe('REMITO R-0042');
    expect(doc.getCreationDate()?.toISOString()).toBe('2026-11-04T00:00:00.000Z');
  });

  it('takes English labels, a locale, a currency symbol and Letter size', async () => {
    const { result, drawn } = await record(() =>
      buildReceiptPdf(order({ shippingCents: 50 }), { labels: LABELS_EN, locale: 'en-US', currencySymbol: 'US$', pageSize: 'Letter' }),
    );
    expect(drawn.map((d) => d.text)).toEqual(expect.arrayContaining(['DELIVERY NOTE', 'Date: 11/04/2026', 'US$45,000.50', 'TOTAL DUE', 'Page 1 of 1']));
    const page = (await PDFDocument.load(result)).getPage(0);
    expect(page.getSize()).toEqual({ width: 612, height: 792 });
    const total = find(drawn, 'US$45,000.50');
    expect(total.x + total.width).toBeCloseTo(612 - LAYOUT.margin, 6);
  });
});

describe('locales whose default digits are not Latin', () => {
  it.each(['ar-EG', 'fa-IR'])('%s prints every amount and date with Latin digits', async (locale) => {
    const { result, drawn } = await record(() =>
      buildReceipt(order({ items: [{ name: 'Helecho', quantity: 1, unitPriceCents: 150_050 }], deliveryOn: '2026-11-06' }), { locale }),
    );
    expect(result.warnings).toEqual([]);
    const money = amounts(drawn).map((d) => d.text);
    expect(money).toHaveLength(3);
    for (const text of money) expect(text).toMatch(/^\$1\D500\D50$/u);
    // A full date in Latin digits. fa-IR formats in its own calendar (1405/08/13), which is the
    // same day; only the digits are forced.
    const date = /\d{2,4}\D\d{2}\D\d{2,4}$/u;
    expect(drawn.find((d) => d.text.startsWith('Fecha:'))?.text).toMatch(date);
    expect(drawn.find((d) => d.text.startsWith('Entrega:'))?.text).toMatch(date);
  });
});

describe('buildReceipt', () => {
  it('returns the same bytes as buildReceiptPdf, with the page count and the warnings', async () => {
    const data = order({ items: items(60), customer: { name: 'Jardín 🌱' } });
    const seen: ReceiptWarning[] = [];
    const built = await buildReceipt(data, { onWarning: (w) => seen.push(w) });
    expect(Buffer.from(built.bytes).equals(Buffer.from(await buildReceiptPdf(data)))).toBe(true);
    expect(built.pageCount).toBe((await PDFDocument.load(built.bytes)).getPageCount());
    expect(built.pageCount).toBeGreaterThan(1);
    expect(built.warnings).toEqual([{ code: 'characters_dropped', field: 'customer.name', count: 1 }]);
    expect(seen).toEqual(built.warnings);
  });
});
