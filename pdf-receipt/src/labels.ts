// The fixed words printed on the document. Spanish is the default because the demo and the
// money format default to es-AR; LABELS_EN is the same set in English. Any label can be
// overridden one by one through options.labels.

// A type alias, not an interface, so a sanitized copy built with Object.fromEntries can be typed as one.
export type ReceiptLabels = {
  readonly title: string;
  readonly date: string;
  readonly customer: string;
  readonly delivery: string;
  readonly product: string;
  readonly detail: string;
  readonly quantity: string;
  readonly unitPrice: string;
  readonly lineTotal: string;
  /** The total when nothing is added to it. */
  readonly total: string;
  /** The goods total when shipping follows and a grand total closes the block. */
  readonly itemsTotal: string;
  readonly shipping: string;
  readonly grandTotal: string;
  readonly previousBalance: string;
  /** A negative previous balance: money the customer has in their favour. */
  readonly creditBalance: string;
  readonly balanceNotIncluded: string;
  readonly notes: string;
  readonly continued: string;
  /** "{page}" and "{pages}" are replaced with numbers. */
  readonly pageOf: string;
  /** Printed when a field had text and none of it could be drawn. */
  readonly unprintable: string;
};

export const LABELS_ES: ReceiptLabels = {
  title: 'REMITO',
  date: 'Fecha',
  customer: 'Cliente',
  delivery: 'Entrega',
  product: 'Producto',
  detail: 'Detalle',
  quantity: 'Cant.',
  unitPrice: 'P. unit.',
  lineTotal: 'Subtotal',
  total: 'Total',
  itemsTotal: 'Total del pedido',
  shipping: 'Envío',
  grandTotal: 'TOTAL FINAL',
  previousBalance: 'Saldo anterior',
  creditBalance: 'Saldo a favor',
  balanceNotIncluded: '(no incluido en el total)',
  notes: 'Aclaraciones',
  continued: 'continuación',
  pageOf: 'Página {page} de {pages}',
  unprintable: '(texto no imprimible)',
};

export const LABELS_EN: ReceiptLabels = {
  title: 'DELIVERY NOTE',
  date: 'Date',
  customer: 'Customer',
  delivery: 'Delivery',
  product: 'Product',
  detail: 'Detail',
  quantity: 'Qty',
  unitPrice: 'Unit price',
  lineTotal: 'Amount',
  total: 'Total',
  itemsTotal: 'Items total',
  shipping: 'Shipping',
  grandTotal: 'TOTAL DUE',
  previousBalance: 'Previous balance',
  creditBalance: 'Credit in your favour',
  balanceNotIncluded: '(not included in the total)',
  notes: 'Notes',
  continued: 'continued',
  pageOf: 'Page {page} of {pages}',
  unprintable: '(text that cannot be printed)',
};
