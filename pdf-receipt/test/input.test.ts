import { describe, expect, it } from 'vitest';
import { buildReceiptPdf, MAX_CENTS, ReceiptInputError, type ReceiptData, type ReceiptLabels, type ReceiptWarning } from '../src/index.ts';
import { order } from './helpers/fixtures.ts';
import { record } from './helpers/record.ts';

async function failure(data: ReceiptData, options = {}): Promise<{ code: string; field: string }> {
  try {
    await buildReceiptPdf(data, options);
  } catch (e) {
    if (e instanceof ReceiptInputError) return { code: e.code, field: e.field };
    throw e;
  }
  throw new Error('expected a ReceiptInputError');
}

const item = (patch: object) => order({ items: [{ name: 'Maceta', quantity: 1, unitPriceCents: 1000, ...patch }] });

describe('numbers that cannot be printed truthfully throw, with the field', () => {
  it.each([
    ['NaN', Number.NaN],
    ['a float of cents', 1000.5],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a string', '1000'],
    ['negative', -1],
  ])('unit price: %s', async (_name, value) => {
    expect(await failure(item({ unitPriceCents: value }))).toEqual({ code: 'invalid_amount', field: 'items[0].unitPriceCents' });
  });

  it('refuses an amount above the maximum', async () => {
    expect(await failure(item({ unitPriceCents: MAX_CENTS + 1 }))).toEqual({ code: 'amount_too_large', field: 'items[0].unitPriceCents' });
    expect(await failure(item({ quantity: 2, unitPriceCents: MAX_CENTS }))).toEqual({ code: 'amount_too_large', field: 'items[0]' });
  });

  it.each([0, -1, 1.0001, Number.NaN, 1_000_001])('quantity %s', async (q) => {
    expect(await failure(item({ quantity: q }))).toEqual({ code: 'invalid_quantity', field: 'items[0].quantity' });
  });

  it('accepts three decimals of quantity', async () => {
    await expect(buildReceiptPdf(item({ quantity: 1.375 }))).resolves.toBeInstanceOf(Uint8Array);
  });

  it('refuses negative shipping and accepts a negative previous balance', async () => {
    expect(await failure(order({ shippingCents: -100 }))).toEqual({ code: 'invalid_amount', field: 'shippingCents' });
    await expect(buildReceiptPdf(order({ previousBalanceCents: -300_000 }))).resolves.toBeInstanceOf(Uint8Array);
  });

  it.each(['2026-02-30', '2026-13-01', '04/11/2026', '2026-11-4', '1899-12-31', ''])('date %j', async (d) => {
    expect(await failure(order({ issuedOn: d }))).toEqual({ code: 'invalid_date', field: 'issuedOn' });
    expect(await failure(order({ deliveryOn: d }))).toEqual({ code: 'invalid_date', field: 'deliveryOn' });
  });

  it('refuses a bad option', async () => {
    expect(await failure(order(), { accentColor: 'red' })).toEqual({ code: 'invalid_option', field: 'accentColor' });
    expect(await failure(order(), { maxNameLines: 0 })).toEqual({ code: 'invalid_option', field: 'maxNameLines' });
    expect(await failure(order(), { maxNameLines: 21 })).toEqual({ code: 'invalid_option', field: 'maxNameLines' });
    expect(await failure(order(), { locale: 'not a locale' })).toEqual({ code: 'invalid_option', field: 'locale' });
    expect(await failure(order(), { locale: '' })).toEqual({ code: 'invalid_option', field: 'locale' });
  });

  it('refuses items that are not an array with the documented error', async () => {
    const data = { ...order(), items: undefined } as unknown as ReceiptData;
    expect(await failure(data)).toEqual({ code: 'invalid_option', field: 'items' });
  });

  it('stops at the first line that takes the items total past the maximum', async () => {
    const lines = Array.from({ length: 900 }, () => ({ name: 'Lote', quantity: 1, unitPriceCents: MAX_CENTS }));
    expect(await failure(order({ items: lines }))).toEqual({ code: 'amount_too_large', field: 'items' });
  });

  it('keeps the default for a label override that is not a string at runtime', async () => {
    const { drawn } = await record(() => buildReceiptPdf(order(), { labels: { title: undefined, customer: 'Para' } as unknown as Partial<ReceiptLabels> }));
    const all = drawn.map((d) => d.text);
    expect(all).toContain('REMITO');
    expect(all).toContain('Para');
    expect(all.some((t) => t.includes('undefined'))).toBe(false);
  });

  it('names the field in the message and nothing from the text', async () => {
    const err = await buildReceiptPdf(item({ unitPriceCents: Number.NaN, name: 'secreto' })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReceiptInputError);
    expect(String(err)).toContain('items[0].unitPriceCents');
    expect(String(err)).not.toContain('secreto');
  });
});

describe('text never throws; warnings say what changed', () => {
  it('reports dropped characters per field', async () => {
    const warnings: ReceiptWarning[] = [];
    await buildReceiptPdf(
      order({ customer: { name: 'Jardín 🌱🌱' }, notes: 'regar 💧', items: [{ name: 'Helecho', detail: 'x6 中', quantity: 1, unitPriceCents: 1 }] }),
      { onWarning: (w) => warnings.push(w) },
    );
    expect(warnings).toEqual([
      { code: 'characters_dropped', field: 'items[0].detail', count: 1 },
      { code: 'characters_dropped', field: 'notes', count: 1 },
      { code: 'characters_dropped', field: 'customer.name', count: 2 },
    ]);
  });

  it('prints a placeholder when a field loses all of its text', async () => {
    const warnings: ReceiptWarning[] = [];
    await buildReceiptPdf(order({ customer: { name: '🌵🌵🌵' } }), { onWarning: (w) => warnings.push(w) });
    expect(warnings).toEqual([{ code: 'characters_dropped', field: 'customer.name', count: 3 }]);
  });

  it('reports party lines beyond the fourth', async () => {
    const warnings: ReceiptWarning[] = [];
    await buildReceiptPdf(order({ customer: { name: 'C', lines: ['1', '2', '3', '4', '5', '6'] } }), { onWarning: (w) => warnings.push(w) });
    expect(warnings).toContainEqual({ code: 'lines_omitted', field: 'customer.lines', count: 2 });
  });
});
