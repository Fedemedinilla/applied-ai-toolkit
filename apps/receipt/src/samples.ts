// The example orders behind the three buttons. Everything is fictional: a plant nursery, its
// customers and hosts under the reserved .example domain.

import type { Draft, DraftItem } from './draft.ts';

export const EMPTY_ITEM: DraftItem = { name: '', detail: '', quantity: '1', unitPrice: '' };

const SHOP = {
  shopName: 'Vivero Ejemplo',
  shopLines: 'Calle de los Ejemplos 123, Ciudad Ejemplo\nventas@vivero.example',
  footer: 'Gracias por su compra. El pago se coordina al momento de la entrega.',
} as const;

export function simpleOrder(today: string): Draft {
  return {
    ...SHOP,
    number: 'R-0042',
    issuedOn: today,
    deliveryOn: '',
    customerName: 'Jardín de Prueba',
    customerLines: 'Pasaje Ficticio 45\ncompras@jardin.example',
    items: [
      { name: 'Maceta de barro 20 cm', detail: 'x6', quantity: '2', unitPrice: '12.500' },
      { name: 'Tierra fértil', detail: '50 l', quantity: '3', unitPrice: '6.800,50' },
      { name: 'Helecho serrucho', detail: 'm. 14', quantity: '5', unitPrice: '4.200' },
    ],
    shipping: '8.000',
    balance: '-3.000',
    notes: 'Entregar por el portón lateral.\nRegar las macetas antes de cargarlas.',
  };
}

/** Text the standard PDF fonts cannot draw, in every kind the library handles. */
export function hostileOrder(today: string): Draft {
  return {
    ...SHOP,
    shopName: 'Vivero 🌿 Ejemplo',
    number: 'R-0099 ★',
    issuedOn: today,
    deliveryOn: '',
    customerName: 'Café “La Estrella” 😀 Ñandú',
    customerLines: '\u202Bשלום\u202C Pasaje 12\nDirección con acento suelto: cafe\u0301',
    items: [
      { name: 'Frutilla 🍓 en maceta', detail: 'x6 ✓', quantity: '3', unitPrice: '9.000' },
      { name: 'Bonsái 中文 盆栽', detail: '', quantity: '1', unitPrice: '148.000,50' },
      { name: 'Ma\u200Bce\u200Dta con espacios de ancho cero', detail: '', quantity: '1', unitPrice: '1.000' },
      { name: `Sustrato ${'con un nombre que no termina nunca '.repeat(60)}`, detail: 'x1', quantity: '1,25', unitPrice: '999' },
      { name: '😀😀😀', detail: '', quantity: '1', unitPrice: '1' },
    ],
    shipping: '0',
    balance: '',
    notes: 'Sin 🥜 por alergia.\n\u202Bمرحبا\u202C saludo en árabe\n' + 'Una nota larga que sigue. '.repeat(30),
  };
}

export function longOrder(today: string, count = 120): Draft {
  const catalog: DraftItem[] = [
    { name: 'Maceta de barro 20 cm', detail: 'x6', quantity: '2', unitPrice: '12.500' },
    { name: 'Tierra fértil', detail: '50 l', quantity: '1', unitPrice: '6.800,50' },
    { name: 'Helecho serrucho', detail: 'm. 14', quantity: '4', unitPrice: '4.200' },
    { name: 'Fertilizante orgánico', detail: '1 kg', quantity: '1,5', unitPrice: '3.100' },
  ];
  return {
    ...simpleOrder(today),
    number: 'R-0120',
    items: Array.from({ length: count }, (_, i) => {
      const base = catalog[i % catalog.length] ?? EMPTY_ITEM;
      return { ...base, name: `${base.name} (${i + 1})` };
    }),
  };
}
