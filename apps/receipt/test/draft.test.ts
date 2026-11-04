import { describe, expect, it } from 'vitest';
import { buildReceiptPdf, type ReceiptWarning } from '../../../pdf-receipt/src/index.ts';
import { fileNameFor } from '../src/app.ts';
import { FIELD, toReceipt } from '../src/draft.ts';
import { locate, warningText } from '../src/messages.ts';
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
});
