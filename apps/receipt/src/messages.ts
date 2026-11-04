// The library's warnings and input errors, in Spanish, pointing at the control they came from.

import type { ReceiptInputError, ReceiptWarning } from '../../../pdf-receipt/src/index.ts';
import { FIELD, type RowRef } from './draft.ts';

export interface Located {
  /** The id of the control to focus, or null when the message is about the whole document. */
  readonly field: string | null;
  readonly text: string;
}

const NAMES: Record<string, string> = {
  number: 'Número',
  'shop.name': 'Nombre del negocio',
  'customer.name': 'Nombre del cliente',
  notes: 'Aclaraciones',
  footer: 'Pie de página',
};

const IDS: Record<string, string> = {
  number: FIELD.number,
  'shop.name': FIELD.shopName,
  'shop.lines': FIELD.shopLines,
  'customer.name': FIELD.customerName,
  'customer.lines': FIELD.customerLines,
  notes: FIELD.notes,
  footer: FIELD.footer,
  shippingCents: FIELD.shipping,
  previousBalanceCents: FIELD.balance,
  issuedOn: FIELD.issuedOn,
  deliveryOn: FIELD.deliveryOn,
};

const ITEM = /^items\[(\d+)\](?:\.(\w+))?$/u;
const PARTY_LINE = /^(shop|customer)\.lines(?:\[(\d+)\])?$/u;

/**
 * A library field path ("items[2].name") as a name and a control id. `rows` maps the index of an
 * item in the data to the row it came from: its id for the control, its position for the name,
 * so the message says the same "Producto 2" as the row's legend.
 */
export function locate(path: string, rows: readonly RowRef[]): { name: string; id: string | null } {
  const item = ITEM.exec(path);
  if (item) {
    const index = Number(item[1]);
    const { id: row, position } = rows[index] ?? { id: index, position: index + 1 };
    const part = item[2];
    const id =
      part === 'detail' ? FIELD.itemDetail(row)
      : part === 'quantity' ? FIELD.itemQuantity(row)
      : part === 'unitPriceCents' ? FIELD.itemUnitPrice(row)
      : FIELD.itemName(row);
    const what = part === 'detail' ? 'detalle' : part === 'quantity' ? 'cantidad' : part === 'unitPriceCents' ? 'precio' : 'nombre';
    return { name: `Producto ${position}, ${what}`, id };
  }
  const party = PARTY_LINE.exec(path);
  if (party) {
    const who = party[1] === 'shop' ? 'Datos del negocio' : 'Datos del cliente';
    return { name: party[2] === undefined ? who : `${who}, renglón ${Number(party[2]) + 1}`, id: IDS[`${party[1]}.lines`] ?? null };
  }
  return { name: NAMES[path] ?? path, id: IDS[path] ?? null };
}

export function warningText(w: ReceiptWarning, rows: readonly RowRef[]): Located {
  switch (w.code) {
    case 'characters_dropped': {
      const { name, id } = locate(w.field, rows);
      const n = w.count === 1 ? 'se quitó un carácter' : `se quitaron ${w.count} caracteres`;
      return { field: id, text: `${name}: ${n} que la fuente del PDF no puede dibujar (emoji u otros alfabetos).` };
    }
    case 'text_clipped': {
      const { name, id } = locate(w.field, rows);
      return { field: id, text: `${name}: no entra completo y se cortó con puntos suspensivos.` };
    }
    case 'lines_omitted': {
      const { name, id } = locate(w.field, rows);
      const n = w.count === 1 ? 'quedó afuera 1' : `quedaron afuera ${w.count}`;
      return { field: id, text: `${name}: se imprimen hasta 4 renglones y ${n}.` };
    }
    case 'logo_unreadable':
      return {
        field: 'logo-file',
        text:
          w.reason === 'unknown_format'
            ? 'El logo no es un PNG ni un JPG; se imprimió el nombre del negocio.'
            : 'El logo no se pudo leer; se imprimió el nombre del negocio.',
      };
  }
}

export function inputErrorText(e: ReceiptInputError, rows: readonly RowRef[]): Located {
  const { name, id } = locate(e.field, rows);
  const why =
    e.code === 'amount_too_large' ? 'el importe es demasiado grande'
    : e.code === 'invalid_date' ? 'la fecha no es válida'
    : e.code === 'invalid_quantity' ? 'la cantidad no es válida'
    : 'el valor no es válido';
  return { field: id, text: `${name}: ${why}.` };
}
