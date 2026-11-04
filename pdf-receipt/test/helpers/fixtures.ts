// A fictional plant nursery and its orders. Every name, address and contact is invented, and the
// hosts are under the reserved .example domain.

import type { ReceiptData, ReceiptItem } from '../../src/index.ts';

export const SHOP = {
  name: 'Vivero Ejemplo',
  lines: ['Calle de los Ejemplos 123, Ciudad Ejemplo', 'ventas@vivero.example'],
} as const;

export function order(overrides: Partial<ReceiptData> = {}): ReceiptData {
  return {
    number: 'R-0042',
    issuedOn: '2026-11-04',
    shop: SHOP,
    customer: { name: 'Jardín de Prueba', lines: ['Pasaje Ficticio 45'] },
    deliveryOn: '2026-11-06',
    items: [
      { name: 'Maceta de barro', detail: 'x6', quantity: 3, unitPriceCents: 900_000 },
      { name: 'Tierra fértil', detail: '50 l', quantity: 2, unitPriceCents: 900_000 },
    ],
    ...overrides,
  };
}

/** n one-line rows with distinct names, "Maceta 1" to "Maceta n". */
export function items(n: number, unitPriceCents = 150_000): ReceiptItem[] {
  return Array.from({ length: n }, (_, i) => ({ name: `Maceta ${i + 1}`, detail: 'x1', quantity: 1, unitPriceCents }));
}
