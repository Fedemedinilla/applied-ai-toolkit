// The form as plain strings (a Draft), and the step that turns it into the library's
// ReceiptData. Kept free of the DOM so it can be tested as a pure function.

import type { ReceiptData, ReceiptItem } from '../../../pdf-receipt/src/index.ts';
import { parseMoney, parseQuantity } from './fields.ts';

export interface DraftItem {
  readonly name: string;
  readonly detail: string;
  readonly quantity: string;
  readonly unitPrice: string;
}

export interface Draft {
  readonly number: string;
  readonly issuedOn: string;
  readonly deliveryOn: string;
  readonly shopName: string;
  /** One printed line per text line. */
  readonly shopLines: string;
  readonly customerName: string;
  readonly customerLines: string;
  readonly items: readonly DraftItem[];
  readonly shipping: string;
  readonly balance: string;
  readonly notes: string;
  readonly footer: string;
}

/** Where a message belongs: a field id in the page, and the message in Spanish. */
export interface FieldError {
  readonly field: string;
  readonly message: string;
}

/** Ids of the controls, shared by the markup, the reader and the error messages. */
export const FIELD = {
  number: 'number',
  issuedOn: 'issued-on',
  deliveryOn: 'delivery-on',
  shopName: 'shop-name',
  shopLines: 'shop-lines',
  customerName: 'customer-name',
  customerLines: 'customer-lines',
  shipping: 'shipping',
  balance: 'balance',
  notes: 'notes',
  footer: 'footer',
  itemName: (row: number) => `item-${row}-name`,
  itemDetail: (row: number) => `item-${row}-detail`,
  itemQuantity: (row: number) => `item-${row}-quantity`,
  itemUnitPrice: (row: number) => `item-${row}-price`,
} as const;

const lines = (text: string): string[] => text.split(/\r?\n/u).filter((l) => l.trim() !== '');

/**
 * Where an item of data.items sits in the page: `id` names its inputs, `position` is the number
 * its legend shows ("Producto 2"). They differ once rows are removed or left blank.
 */
export interface RowRef {
  readonly id: number;
  readonly position: number;
}

export type DraftResult =
  | { readonly ok: true; readonly data: ReceiptData; /** One per item in data.items. */ readonly rows: readonly RowRef[] }
  | { readonly ok: false; readonly errors: readonly FieldError[] };

/**
 * `rowIds` gives the id each item row has in the page, in page order (rows keep their id when
 * others are removed), so an error points at the right input and names the row's position.
 */
export function toReceipt(draft: Draft, rowIds: readonly number[]): DraftResult {
  const errors: FieldError[] = [];
  const items: ReceiptItem[] = [];
  const rows: RowRef[] = [];
  draft.items.forEach((item, i) => {
    const row = rowIds[i] ?? i;
    // A row added and not filled in yet (the quantity starts at 1) is left out, not an error.
    const blank = !item.name.trim() && !item.detail.trim() && !item.unitPrice.trim();
    if (blank) return;
    const quantity = parseQuantity(item.quantity);
    const price = parseMoney(item.unitPrice, { negative: false });
    if (!quantity.ok) errors.push({ field: FIELD.itemQuantity(row), message: quantity.message });
    if (!price.ok) errors.push({ field: FIELD.itemUnitPrice(row), message: price.message });
    else if (price.value === null) errors.push({ field: FIELD.itemUnitPrice(row), message: 'Falta el precio.' });
    if (quantity.ok && price.ok && price.value !== null) {
      items.push({ name: item.name, detail: item.detail, quantity: quantity.value, unitPriceCents: price.value });
      rows.push({ id: row, position: i + 1 });
    }
  });

  const shipping = parseMoney(draft.shipping, { negative: false });
  if (!shipping.ok) errors.push({ field: FIELD.shipping, message: shipping.message });
  const balance = parseMoney(draft.balance, { negative: true });
  if (!balance.ok) errors.push({ field: FIELD.balance, message: balance.message });
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(draft.issuedOn)) errors.push({ field: FIELD.issuedOn, message: 'Falta la fecha.' });
  if (draft.deliveryOn && !/^\d{4}-\d{2}-\d{2}$/u.test(draft.deliveryOn)) {
    errors.push({ field: FIELD.deliveryOn, message: 'La fecha no es válida.' });
  }
  if (errors.length > 0 || !shipping.ok || !balance.ok) return { ok: false, errors };

  return {
    ok: true,
    rows,
    data: {
      number: draft.number,
      issuedOn: draft.issuedOn,
      deliveryOn: draft.deliveryOn || null,
      shop: { name: draft.shopName, lines: lines(draft.shopLines) },
      customer: { name: draft.customerName, lines: lines(draft.customerLines) },
      items,
      shippingCents: shipping.value,
      previousBalanceCents: balance.value,
      notes: draft.notes.trim() ? draft.notes : null,
      footer: draft.footer,
    },
  };
}
