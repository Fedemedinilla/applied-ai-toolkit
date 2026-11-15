import { describe, expect, it } from 'vitest';
import { buildReceipt, buildReceiptPdf, ReceiptInputError, type ReceiptWarning } from '../../../pdf-receipt/src/index.ts';
import { fileNameFor } from '../src/app.ts';
import { FIELD, toReceipt } from '../src/draft.ts';
import { inputErrorText, locate, warningText } from '../src/messages.ts';
import { hostileOrder, longOrder, simpleOrder } from '../src/samples.ts';

const TODAY = '2026-11-04';

describe('toReceipt', () => {
  it('turns the simple sample into cents and lines', () => {
    const r = toReceipt(simpleOrder(TODAY), [0, 1, 2]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.items.map((i) => [i.quantity, i.unitPriceCents])).toEqual([[2, 1_250_000], [3, 680_050], [5, 420_000]]);
    expect(r.data.shippingCents).toBe(800_000);
    expect(r.data.previousBalanceCents).toBe(-300_000);
    expect(r.data.customer.lines).toEqual(['Pasaje Ficticio 45', 'compras@jardin.example']);
    expect(r.data.deliveryOn).toBeNull();
  });

  it('skips blank rows and keeps the row id and position of each item', () => {
    const d = simpleOrder(TODAY);
    const r = toReceipt({ ...d, items: [d.items[0]!, { name: '', detail: '', quantity: '', unitPrice: '' }, d.items[1]!] }, [7, 8, 9]);
    expect(r.ok && r.rows).toEqual([{ id: 7, position: 1 }, { id: 9, position: 3 }]);
  });

  it('names a warning after the row the page shows when an earlier row is blank', async () => {
    const d = simpleOrder(TODAY);
    const blank = { name: '', detail: '', quantity: '1', unitPrice: '' };
    const r = toReceipt({ ...d, items: [blank, { ...d.items[0]!, name: 'Helecho 🌿' }] }, [0, 1]);
    if (!r.ok) throw new Error('expected a valid draft');
    const warnings: ReceiptWarning[] = [];
    await buildReceiptPdf(r.data, { onWarning: (w) => warnings.push(w) });
    expect(warnings.map((w) => warningText(w, r.rows))).toContainEqual({
      field: FIELD.itemName(1),
      text: 'Producto 2, nombre: se quitó un carácter que la fuente del PDF no puede dibujar (emoji u otros alfabetos).',
    });
  });

  it('puts each error on its own control, by row id', () => {
    const d = simpleOrder(TODAY);
    const r = toReceipt(
      { ...d, shipping: '8.5', balance: 'mucho', items: [{ name: 'Maceta', detail: '', quantity: '1.5', unitPrice: '' }] },
      [4],
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.map((e) => e.field)).toEqual([FIELD.itemQuantity(4), FIELD.itemUnitPrice(4), FIELD.shipping, FIELD.balance]);
  });

  it('puts a line total over the maximum on that row\'s price, in Spanish', () => {
    const d = simpleOrder(TODAY);
    const r = toReceipt({ ...d, items: [{ name: 'Maceta', detail: '', quantity: '1000000', unitPrice: '99.999.999.999,99' }] }, [3]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toEqual([{ field: FIELD.itemUnitPrice(3), message: 'El subtotal (cantidad por precio) es demasiado grande.' }]);
  });

  it('builds every sample', async () => {
    for (const sample of [simpleOrder(TODAY), hostileOrder(TODAY), longOrder(TODAY)]) {
      const r = toReceipt(sample, sample.items.map((_, i) => i));
      expect(r.ok).toBe(true);
      if (r.ok) expect((await buildReceiptPdf(r.data)).length).toBeGreaterThan(1000);
    }
  });
});

describe('messages', () => {
  it('names an item field by its position and points at its control by row id', () => {
    expect(locate('items[1].name', [{ id: 3, position: 1 }, { id: 5, position: 4 }])).toEqual({ name: 'Producto 4, nombre', id: FIELD.itemName(5) });
    expect(locate('customer.lines[2]', [])).toEqual({ name: 'Datos del cliente, renglón 3', id: FIELD.customerLines });
    expect(locate('notes', [])).toEqual({ name: 'Aclaraciones', id: FIELD.notes });
  });

  it('names a line total by its row and points at the price, not the name', () => {
    expect(locate('items[0]', [{ id: 2, position: 3 }])).toEqual({ name: 'Producto 3, subtotal', id: FIELD.itemUnitPrice(2) });
  });

  it('words every input error in Spanish, with no internal path', async () => {
    const rows = [{ id: 0, position: 1 }];
    const errors = [
      new ReceiptInputError('invalid_date', 'issuedOn', 'x'),
      new ReceiptInputError('invalid_date', 'deliveryOn', 'x'),
      new ReceiptInputError('amount_too_large', 'items', 'x'),
      new ReceiptInputError('amount_too_large', 'shippingCents', 'x'),
      new ReceiptInputError('amount_too_large', 'previousBalanceCents', 'x'),
      new ReceiptInputError('amount_too_large', 'items[0]', 'x'),
    ];
    const texts = errors.map((e) => inputErrorText(e, rows));
    expect(texts).toEqual([
      { field: FIELD.issuedOn, text: 'Fecha: la fecha no es válida.' },
      { field: FIELD.deliveryOn, text: 'Entrega: la fecha no es válida.' },
      { field: null, text: 'La suma de los productos es demasiado grande.' },
      { field: FIELD.shipping, text: 'El total del remito es demasiado grande.' },
      { field: FIELD.balance, text: 'Saldo anterior: el importe es demasiado grande.' },
      { field: FIELD.itemUnitPrice(0), text: 'Producto 1, subtotal: el importe es demasiado grande.' },
    ]);
    // A date with the right shape that is not on the calendar gets past toReceipt.
    const r = toReceipt({ ...simpleOrder(TODAY), issuedOn: '2026-02-30' }, [0, 1, 2]);
    if (!r.ok) throw new Error('expected the shape check to pass');
    const thrown = await buildReceipt(r.data).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(ReceiptInputError);
    const located = inputErrorText(thrown as ReceiptInputError, r.rows);
    expect(located.text).not.toMatch(/[a-z][A-Z]/u);
    expect(located).toEqual({ field: FIELD.issuedOn, text: 'Fecha: la fecha no es válida.' });
  });

  it('words every warning in Spanish', () => {
    const cases: Array<[ReceiptWarning, string]> = [
      [{ code: 'characters_dropped', field: 'customer.name', count: 2 }, 'Nombre del cliente: se quitaron 2 caracteres'],
      [{ code: 'characters_dropped', field: 'notes', count: 1 }, 'Aclaraciones: se quitó un carácter'],
      [{ code: 'text_clipped', field: 'items[0].name' }, 'Producto 1, nombre: no entra completo'],
      [{ code: 'lines_omitted', field: 'shop.lines', count: 1 }, 'Datos del negocio: se imprimen hasta 4 renglones y quedó afuera 1.'],
      [{ code: 'logo_unreadable', reason: 'unknown_format' }, 'El logo no es un PNG ni un JPG'],
    ];
    for (const [w, start] of cases) expect(warningText(w, [{ id: 0, position: 1 }]).text.startsWith(start), start).toBe(true);
  });
});

describe('fileNameFor', () => {
  it('keeps letters, digits and dashes', () => {
    expect(fileNameFor('R-0042')).toBe('remito-R-0042.pdf');
    expect(fileNameFor('R 0099 ★ Ñandú/../x')).toBe('remito-R-0099-Nandu-x.pdf');
    expect(fileNameFor('😀')).toBe('remito.pdf');
  });

  it('never ends the name in a dash when it cuts a long number at 60 characters', () => {
    expect(fileNameFor(`${'A'.repeat(59)} B`)).toBe(`remito-${'A'.repeat(59)}.pdf`);
  });
});
