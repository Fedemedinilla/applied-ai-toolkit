// The words the parser knows. This is data, not logic: identifiers are English, the words people
// say stay in Rioplatense Spanish, written the way `normalize` leaves them (lower case, no accents).

/** Words that multiply the number in front of them. Callers can add their own through `parseAmount`. */
export const BASE_SCALES: Readonly<Record<string, number>> = {
  mil: 1_000,
  miles: 1_000,
  k: 1_000,
  luca: 1_000,
  lucas: 1_000,
  millon: 1_000_000,
  millones: 1_000_000,
  palo: 1_000_000,
  palos: 1_000_000,
  melon: 1_000_000,
  melones: 1_000_000,
  gamba: 100,
  gambas: 100,
};

/** Words that only say "this is money" without changing the number. */
export const NEUTRAL_UNITS: ReadonlySet<string> = new Set(['mango', 'mangos', 'peso', 'pesos', 'pe', 'ars', 'guita']);

/** Units of stuff. A number in front of one of these is counting, not pricing. */
export const COUNT_NOUNS: ReadonlySet<string> = new Set([
  'kilo', 'kilos', 'kg', 'kgs', 'gramo', 'gramos', 'gr', 'g',
  'litro', 'litros', 'lt', 'lts', 'l', 'ml', 'cc',
  'unidad', 'unidades', 'u', 'docena', 'docenas', 'decena', 'decenas',
  'bolsa', 'bolsas', 'caja', 'cajas', 'cajon', 'cajones', 'paquete', 'paquetes',
  'tarro', 'tarros', 'lata', 'latas', 'botella', 'botellas', 'maple', 'maples',
  'par', 'pares', 'pack', 'packs', 'metro', 'metros', 'm2', 'bidon', 'bidones',
  'cuota', 'cuotas', 'hora', 'horas', 'dia', 'dias', 'mes', 'meses',
]);

/** How many single items a pack holds, for when the price is quoted per unit. */
export const PACK_SIZES: Readonly<Record<string, number>> = {
  docena: 12, docenas: 12, decena: 10, decenas: 10, par: 2, pares: 2,
};

/** Function words. A number followed by one of these stands on its own. */
export const CONNECTORS: ReadonlySet<string> = new Set([
  'a', 'al', 'de', 'del', 'en', 'con', 'para', 'por', 'y', 'e', 'o', 'u', 'que',
  'el', 'la', 'lo', 'los', 'las', 'un', 'una', 'unos', 'unas', 'mi', 'mis', 'su', 'sus',
  'este', 'esta', 'esto', 'ese', 'esa', 'eso', 'cada', 'mas', 'menos', 'sin', 'ya',
]);

/** The words that join two figures into one movement: "5 mil de luz y 3 mil de gas". */
export const JOINERS: readonly string[] = ['y', 'mas', 'e'];

/**
 * Words that mark the NEXT amount as something other than the movement: what the customer handed
 * over, what is still owed, what is left in the till. An "y" between two figures is not proof they
 * are parts of one payment.
 */
export const NOT_THE_MOVEMENT: ReadonlySet<string> = new Set([
  'pagaron', 'pago', 'pagan', 'con', 'vuelto', 'cambio', 'recibi', 'recibio', 'entrego',
  'debo', 'debe', 'deben', 'debia', 'adeuda', 'resta', 'restan', 'falta', 'faltan',
  'queda', 'quedan', 'quedo', 'sobra', 'sobran', 'saldo', 'tengo', 'tenia', 'habia',
  'todavia', 'aun', 'quedaron',
]);

/**
 * Words that say a figure is a PART of a total already named: "cobre 120 mil, 40 mil de sena y el
 * resto en 30 dias". Adding those two invents 160.000, a figure the sentence never contained.
 * The marker sits AFTER its figure ("40 mil de sena"). In "un anticipo de 50 mil" it comes first,
 * and there the down payment really is money on top.
 */
export const PART_OF_THE_WHOLE: ReadonlySet<string> = new Set(['sena', 'anticipo', 'adelanto', 'entrega', 'resto', 'saldo']);

/** Words that come right before a price: "a 8000", "por 5000", "de 15000". */
export const PRICE_MARKERS: ReadonlySet<string> = new Set(['a', 'por', 'de', 'en']);

/** Nouns that name one payment out of several: "3 cuotas de 25 mil", "4 pagos de 90 mil". */
export const INSTALMENT_NOUNS: ReadonlySet<string> = new Set(['cuota', 'cuotas', 'pago', 'pagos']);

/**
 * Currencies the caller cannot store. The parser returns a bare number and the caller stamps one
 * fixed currency on it, so the figure of a sentence said in dollars would be filed as that many
 * pesos. The number is readable; storing it is what cannot be done, so the parser refuses and the
 * app asks. Currencies with a homograph in ordinary speech ("reales", "libras") are left out on
 * purpose: a false alarm on "el precio real" would cost more than it saves.
 */
export const FOREIGN_CURRENCY = /(^|[^a-z])(u\$s|us\$|usd|dolares|dolar|euros|euro|eur)([^a-z]|$)/u;

/** The number that follows one of these is a reference, never money. */
export const REFERENCE_MARKERS: ReadonlySet<string> = new Set([
  'pedido', 'factura', 'orden', 'remito', 'comprobante', 'nro', 'numero', 'n', 'ticket',
  'cuit', 'cuil', 'tel', 'telefono', 'celular', 'dni', 'cbu', 'alias',
]);

export const MONTHS: ReadonlySet<string> = new Set([
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'setiembre', 'octubre', 'noviembre', 'diciembre',
]);

/**
 * "gaste veinte, no, pera, treinta mil": everything up to the marker is discarded. "no" and "para"
 * are also ordinary words, and the README lists what that costs.
 */
export const CORRECTION_MARKERS: ReadonlySet<string> = new Set(['no', 'pera', 'para', 'perdon', 'perdona', 'digo', 'mejor']);

export const INCOME_VERBS: ReadonlySet<string> = new Set([
  'cobre', 'cobro', 'cobraron', 'vendi', 'vendio', 'vendimos', 'facture', 'facturo',
  'ingreso', 'ingresaron', 'entro', 'entraron', 'deposito', 'depositaron',
  'transfirieron', 'pagaron', 'recibi', 'recaude',
]);

export const EXPENSE_VERBS: ReadonlySet<string> = new Set([
  'gaste', 'gasto', 'pague', 'pago', 'compre', 'compro', 'abone', 'abono',
  'salio', 'salieron', 'cargue', 'inverti', 'deposite',
]);

/**
 * Fixed expressions that talk about money without naming an amount. Matched as substrings of the
 * normalized sentence, so "doscientos dos pesos" also matches "dos pesos" (see the README's limits).
 */
export const NON_AMOUNT_IDIOMS: readonly string[] = [
  'una fortuna', 'un platal', 'un dineral', 'una banda', 'un huevo',
  'dos mangos', 'cuatro mangos', 'dos pesos',
];

export const NUMBER_WORDS: Readonly<Record<string, number>> = {
  cero: 0, un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5,
  seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12,
  trece: 13, catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17,
  dieciocho: 18, diecinueve: 19, veinte: 20, veintiuno: 21, veintiun: 21,
  veintidos: 22, veintitres: 23, veinticuatro: 24, veinticinco: 25,
  veintiseis: 26, veintisiete: 27, veintiocho: 28, veintinueve: 29,
  treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70,
  ochenta: 80, noventa: 90, cien: 100, ciento: 100, doscientos: 200,
  trescientos: 300, cuatrocientos: 400, quinientos: 500, seiscientos: 600,
  setecientos: 700, ochocientos: 800, novecientos: 900,
};
