// Income or expense, and a category, guessed from keywords. No model: a keyword table is instant,
// free, and when it is wrong the owner can see which word did it, because the row keeps the keyword.
//
// Matching is by whole words after folding accents and case. Substring matching is the classic
// failure here: "centro" contains "entro" (an expense filed as income) and "gasoil" contains "gas"
// (fuel filed as a utility bill).

export type Kind = 'income' | 'expense';

/** Closed lists. An income never gets an expense category, and the reverse. */
export const INCOME_CATEGORIES = ['Ventas', 'Pedidos y encargos'] as const;
export const EXPENSE_CATEGORIES = [
  'Materia prima',
  'Envases',
  'Servicios',
  'Sueldos',
  'Alquiler',
  'Mantenimiento',
  'Impuestos',
  'Transporte',
  'Otros gastos',
] as const;

export type Category = (typeof INCOME_CATEGORIES)[number] | (typeof EXPENSE_CATEGORIES)[number];

/** The category a row falls into when no keyword matched. Shown as a default, not as a match. */
export const DEFAULT_CATEGORY: Readonly<Record<Kind, Category>> = {
  income: 'Ventas',
  expense: 'Otros gastos',
};

// Verbs and fixed phrases that say which way the money went. Written as the owner would write
// them, accents included, because the preview shows the matched entry ("por \"vendí\""). Matching
// folds both sides, so "vendi" typed without the accent still matches.
// "me cobró" is an expense even though "cobré" is income: the supplier charged me. The earliest
// match in the sentence wins, so "cobré 50 mil y pagué 12" reads as income (the parser asks about
// that sentence anyway, as mixed_directions), and "me cobró" beats "cobro" because it starts first.
const INCOME_PHRASES = [
  'vendí', 'vendimos', 'vendió', 'vendieron', 'cobré', 'cobramos', 'cobro', 'cobra', 'facturé',
  'facturamos', 'me pagaron', 'nos pagaron', 'pagaron', 'me transfirieron', 'transfirieron',
  'me depositaron', 'depositaron', 'entró', 'entraron', 'ingresó', 'ingresaron', 'recibí',
  'recaudé', 'cobro de', 'cierre de caja', 'cierre del día', 'me devolvieron', 'me reintegraron',
  'me dieron', 'me depositó', 'me transfirió', 'transfirió', 'me dejaron', 'me prestaron', 'emití',
];
const EXPENSE_PHRASES = [
  'gasté', 'gastamos', 'pagué', 'pagamos', 'compré', 'compramos', 'aboné', 'me cobró', 'me cobra',
  'nos cobra', 'me cobraron', 'nos cobraron', 'me facturó', 'me salió', 'salió', 'me costó',
  'costó', 'cargué', 'invertí', 'deposité', 'transferí', 'le pagué', 'saqué', 'devolví', 'puse',
];

// Bakery keywords. In Argentina "facturas" are pastries, so the noun is a product while the verb
// "facturé" (I invoiced) is income. Order matters: the first category with a match wins, so
// "bolsas de harina" is raw material before it is packaging.
const INCOME_KEYWORDS: ReadonlyArray<readonly [Category, readonly string[]]> = [
  ['Pedidos y encargos', ['pedido', 'pedidos', 'encargo', 'encargos', 'catering', 'evento', 'cumpleaños', 'casamiento']],
];
const EXPENSE_KEYWORDS: ReadonlyArray<readonly [Category, readonly string[]]> = [
  ['Materia prima', [
    'harina', 'azúcar', 'manteca', 'margarina', 'huevo', 'huevos', 'levadura', 'crema', 'leche',
    'dulce de leche', 'chocolate', 'grasa', 'membrillo', 'sal', 'aceite', 'fruta', 'frutas',
    'insumos', 'mercadería', 'proveedor', 'molino', 'queso', 'jamón', 'semillas',
  ]],
  ['Envases', ['caja', 'cajas', 'bolsa', 'bolsas', 'bandeja', 'bandejas', 'envase', 'envases', 'papel', 'blondas', 'cinta']],
  ['Servicios', ['luz', 'gas', 'agua', 'internet', 'teléfono', 'celular', 'boleta', 'boletas', 'expensas', 'abl']],
  ['Sueldos', ['sueldo', 'sueldos', 'aguinaldo', 'jornal', 'jornales', 'empleado', 'empleada', 'empleados', 'panadero', 'ayudante', 'cargas sociales']],
  ['Alquiler', ['alquiler']],
  ['Mantenimiento', ['horno', 'amasadora', 'sobadora', 'heladera', 'gasista', 'electricista', 'plomero', 'arreglo', 'repuesto', 'técnico', 'service']],
  ['Impuestos', ['impuesto', 'impuestos', 'monotributo', 'ingresos brutos', 'iibb', 'tasa', 'municipal']],
  ['Transporte', ['nafta', 'gasoil', 'flete', 'fletes', 'envío', 'envíos', 'peaje', 'estacionamiento', 'remis']],
];

/** Lowercase, no accents, every run of non-letters and non-digits collapsed to one space. */
export function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Position of `phrase` as whole words in folded text, or -1. The phrase is folded here. */
function wordIndex(foldedText: string, phrase: string): number {
  return ` ${foldedText} `.indexOf(` ${fold(phrase)} `);
}

export interface KindGuess {
  kind: Kind;
  /** The phrase that decided it, or null when nothing matched and the default (expense) applied. */
  keyword: string | null;
}

const KIND_PHRASES: ReadonlyArray<readonly [string, Kind]> = [
  ...INCOME_PHRASES.map((p) => [p, 'income'] as const),
  ...EXPENSE_PHRASES.map((p) => [p, 'expense'] as const),
];

export function kindOf(text: string): KindGuess {
  const folded = fold(text);
  let best: { at: number; length: number; kind: Kind; keyword: string } | null = null;
  for (const [phrase, kind] of KIND_PHRASES) {
    const at = wordIndex(folded, phrase);
    if (at < 0) continue;
    // Earliest wins; at the same position the longer phrase wins ("cobro de" over "cobro").
    if (!best || at < best.at || (at === best.at && phrase.length > best.length)) {
      best = { at, length: phrase.length, kind, keyword: phrase };
    }
  }
  return best ? { kind: best.kind, keyword: best.keyword } : { kind: 'expense', keyword: null };
}

export interface CategoryGuess {
  category: Category;
  /** The word that matched, or null when the category is the default for the kind. */
  keyword: string | null;
}

export function categorise(text: string, kind: Kind): CategoryGuess {
  const folded = fold(text);
  const table = kind === 'income' ? INCOME_KEYWORDS : EXPENSE_KEYWORDS;
  for (const [category, words] of table) {
    for (const word of words) {
      if (wordIndex(folded, word) >= 0) return { category, keyword: word };
    }
  }
  return { category: DEFAULT_CATEGORY[kind], keyword: null };
}
