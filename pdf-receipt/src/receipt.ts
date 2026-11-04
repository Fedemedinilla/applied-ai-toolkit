// buildReceiptPdf: data in, PDF bytes out. pdf-lib only, no Node APIs, so the same call runs in a
// serverless function and in a browser tab.
//
// The page is laid out top to bottom with one cursor, `y`, the baseline of the next line. Before
// anything is drawn, `ensure(height)` checks that it fits above the footer zone and opens a
// continuation page when it does not. Footers are drawn last, once the page count is known.

import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFImage, type PDFPage, type RGB } from 'pdf-lib';
import { prepare, ReceiptInputError, type PreparedReceipt, type ReceiptData, type ReceiptWarning } from './input.ts';
import { LABELS_ES, type ReceiptLabels } from './labels.ts';
import { clip, fitSize, wrap } from './text.ts';
import { toWinAnsiLine } from './winansi.ts';

export interface ReceiptOptions {
  /**
   * PNG or JPEG bytes, detected from the file signature. Pass bytes, not a URL: a serverless
   * function has no public/ folder to read from, so the logo travels inside the bundle (for
   * example as a base64 constant). A logo that cannot be read is replaced by the shop name.
   */
  readonly logo?: Uint8Array | ArrayBuffer | null | undefined;
  readonly labels?: Partial<ReceiptLabels> | undefined;
  /** Digit grouping, decimal sign and date order. Default 'es-AR'. */
  readonly locale?: string | undefined;
  /** Default '$'. */
  readonly currencySymbol?: string | undefined;
  /** Default 'A4'. */
  readonly pageSize?: 'A4' | 'Letter' | undefined;
  /** '#rrggbb'. Default '#1f5f5b'. */
  readonly accentColor?: string | undefined;
  /** Lines a product name may wrap to before it is clipped, 1 to 20. Default 3. */
  readonly maxNameLines?: number | undefined;
  /** Text that was changed to fit the fonts or the page, and a logo that could not be used. */
  readonly onWarning?: ((warning: ReceiptWarning) => void) | undefined;
}

const PAGE_SIZES = { A4: [595.28, 841.89], Letter: [612, 792] } as const;

/** Layout geometry in points. Exported for the tests; not part of the public entry. */
export const LAYOUT = {
  margin: 48,
  /** Nothing but the footer is drawn below this line. */
  contentBottom: 100,
  footerTextY: 62,
  footerRuleY: 46,
  footerSmallY: 32,
  /** Space between a label that ends at a column edge and an amount that must not touch it. */
  amountGap: 4,
  nameLineHeight: 12,
  rowGap: 12,
  noteLineHeight: 15,
  logoMaxWidth: 140,
  logoMaxHeight: 44,
} as const;

/** Column edges for a page of width `width`, measured from the right so Letter and A4 both work. */
export function columns(width: number) {
  const lineTotalRight = width - LAYOUT.margin;
  const unitPriceRight = lineTotalRight - 84;
  const quantityRight = unitPriceRight - 80;
  const detailLeft = quantityRight - 110;
  return {
    nameLeft: LAYOUT.margin,
    nameWidth: detailLeft - LAYOUT.margin - 10,
    detailLeft,
    detailWidth: 62,
    quantityRight,
    quantityWidth: quantityRight - (detailLeft + 62 + 4),
    unitPriceRight,
    unitPriceWidth: unitPriceRight - quantityRight - 6,
    lineTotalRight,
    /** Totals: labels end at unitPriceRight, amounts sit between it and lineTotalRight. */
    totalsAmountWidth: lineTotalRight - unitPriceRight - LAYOUT.amountGap,
  };
}

const INK = rgb(0.13, 0.13, 0.12);
const MUTED = rgb(0.4, 0.39, 0.36);
const RULE = rgb(0.82, 0.8, 0.76);
const BAND = rgb(0.94, 0.93, 0.9);

function parseColor(hex: string): RGB {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) throw new ReceiptInputError('invalid_option', 'accentColor', 'must be a color as #rrggbb');
  return rgb(parseInt(m[1] ?? '0', 16) / 255, parseInt(m[2] ?? '0', 16) / 255, parseInt(m[3] ?? '0', 16) / 255);
}

/** The Spanish labels with the caller's overrides. An override that is not a string keeps the default. */
function mergeLabels(overrides: Partial<ReceiptLabels> | undefined): ReceiptLabels {
  const merged: { -readonly [K in keyof ReceiptLabels]: string } = { ...LABELS_ES };
  for (const key of Object.keys(LABELS_ES) as (keyof ReceiptLabels)[]) {
    const value: unknown = overrides?.[key];
    if (typeof value === 'string') merged[key] = value;
  }
  return merged;
}

/** A well-formed BCP 47 tag. Intl would throw a bare RangeError on the first amount otherwise. */
function checkLocale(locale: unknown): string {
  try {
    if (typeof locale === 'string' && Intl.getCanonicalLocales(locale).length === 1) return locale;
  } catch {
    // Fall through to the documented error.
  }
  throw new ReceiptInputError('invalid_option', 'locale', 'must be a BCP 47 language tag such as es-AR');
}

function logoFormat(bytes: Uint8Array): 'png' | 'jpg' | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  return null;
}

async function embedLogo(doc: PDFDocument, logo: Uint8Array | ArrayBuffer, warn: (w: ReceiptWarning) => void): Promise<PDFImage | null> {
  const bytes = logo instanceof Uint8Array ? logo : new Uint8Array(logo);
  const format = logoFormat(bytes);
  if (!format) {
    warn({ code: 'logo_unreadable', reason: 'unknown_format' });
    return null;
  }
  try {
    return format === 'png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
  } catch {
    // A broken logo must not take the document down with it: the shop name is printed instead.
    warn({ code: 'logo_unreadable', reason: 'embed_failed' });
    return null;
  }
}

/**
 * Builds the PDF. Throws ReceiptInputError for numbers, dates or options that cannot be printed
 * truthfully; never throws for text, whatever characters it holds.
 */
export async function buildReceiptPdf(data: ReceiptData, options: ReceiptOptions = {}): Promise<Uint8Array<ArrayBuffer>> {
  return (await buildReceipt(data, options)).bytes;
}

export interface BuiltReceipt {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly pageCount: number;
  /** Every warning, in the order onWarning received them. */
  readonly warnings: readonly ReceiptWarning[];
}

/** buildReceiptPdf with the page count and the warnings returned next to the bytes. */
export async function buildReceipt(data: ReceiptData, options: ReceiptOptions = {}): Promise<BuiltReceipt> {
  const warnings: ReceiptWarning[] = [];
  const warn = (w: ReceiptWarning): void => {
    warnings.push(w);
    options.onWarning?.(w);
  };
  const maxNameLines = options.maxNameLines ?? 3;
  // 20 lines make a 252 pt row; anything taller could not fit on one page and would run over the footer.
  if (!Number.isInteger(maxNameLines) || maxNameLines < 1 || maxNameLines > 20) {
    throw new ReceiptInputError('invalid_option', 'maxNameLines', 'must be an integer from 1 to 20');
  }
  const locale = checkLocale(options.locale ?? 'es-AR');
  const accent = parseColor(options.accentColor ?? '#1f5f5b');
  const symbol = toWinAnsiLine(options.currencySymbol ?? '$').text;
  const r = prepare(data, {
    labels: mergeLabels(options.labels),
    format: { locale, symbol },
    warn,
  });

  const doc = await PDFDocument.create();
  // Metadata dates come from the issue date, not the clock, so the same input gives the same bytes.
  const [y0, m0, d0] = r.issuedOn.split('-').map(Number);
  const issued = new Date(Date.UTC(y0 ?? 1970, (m0 ?? 1) - 1, d0 ?? 1));
  doc.setCreationDate(issued);
  doc.setModificationDate(issued);
  doc.setTitle(`${r.labels.title} ${r.number}`.trim());
  doc.setProducer('pdf-receipt (pdf-lib)');
  doc.setCreator('pdf-receipt');

  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const logo = options.logo ? await embedLogo(doc, options.logo, warn) : null;

  draw(doc, r, { regular, bold, logo, accent, maxNameLines, pageSize: PAGE_SIZES[options.pageSize ?? 'A4'], warn });
  const saved = await doc.save();
  // pdf-lib types the result over ArrayBufferLike; it is always a plain ArrayBuffer, and the
  // narrower type lets a browser caller pass it to new Blob() without a cast.
  const bytes = saved.buffer instanceof ArrayBuffer ? new Uint8Array(saved.buffer, saved.byteOffset, saved.byteLength) : new Uint8Array(saved);
  return { bytes, pageCount: doc.getPageCount(), warnings };
}

interface DrawContext {
  readonly regular: PDFFont;
  readonly bold: PDFFont;
  readonly logo: PDFImage | null;
  readonly accent: RGB;
  readonly maxNameLines: number;
  readonly pageSize: readonly [number, number];
  readonly warn: (w: ReceiptWarning) => void;
}

function draw(doc: PDFDocument, r: PreparedReceipt, ctx: DrawContext): void {
  const { regular, bold, logo, accent, warn } = ctx;
  const [W, H] = ctx.pageSize;
  const M = LAYOUT.margin;
  const contentWidth = W - 2 * M;
  const col = columns(W);
  const L = r.labels;

  let page: PDFPage = doc.addPage([W, H]);
  let y = 0;

  // Every string reaching these helpers is WinAnsi already (input.ts, labels, formatted amounts).
  const text = (s: string, x: number, at: number, font: PDFFont, size: number, color: RGB = INK): void => {
    if (s) page.drawText(s, { x, y: at, size, font, color });
  };
  const right = (s: string, xRight: number, at: number, font: PDFFont, size: number, color: RGB = INK): void => {
    if (s) page.drawText(s, { x: xRight - font.widthOfTextAtSize(s, size), y: at, size, font, color });
  };
  /** Clipped to `maxWidth`, with a warning naming the field when something was cut. */
  const fitted = (s: string, font: PDFFont, size: number, maxWidth: number, field: string): string => {
    const c = clip(font, s, size, maxWidth);
    if (c.clipped) warn({ code: 'text_clipped', field });
    return c.text;
  };
  /** A right-aligned amount drawn smaller if it would run past the left edge of its zone. */
  const amount = (s: string, xRight: number, at: number, font: PDFFont, size: number, zoneWidth: number, color: RGB = INK): void =>
    right(s, xRight, at, font, fitSize(font, s, size, zoneWidth), color);
  const rule = (at: number, thickness = 0.75, from: number = M, to: number = W - M): void => {
    page.drawLine({ start: { x: from, y: at }, end: { x: to, y: at }, thickness, color: RULE });
  };
  const band = (): void => {
    page.drawRectangle({ x: 0, y: H - 8, width: W, height: 8, color: accent });
  };

  const tableHead = (): void => {
    page.drawRectangle({ x: M - 6, y: y - 7, width: contentWidth + 12, height: 22, color: BAND });
    text(L.product, col.nameLeft, y, bold, 9);
    text(clip(bold, L.detail, 9, col.detailWidth).text, col.detailLeft, y, bold, 9);
    right(clip(bold, L.quantity, 9, col.quantityWidth).text, col.quantityRight, y, bold, 9);
    right(clip(bold, L.unitPrice, 9, col.unitPriceWidth).text, col.unitPriceRight, y, bold, 9);
    right(clip(bold, L.lineTotal, 9, col.totalsAmountWidth).text, col.lineTotalRight, y, bold, 9);
    y -= 25;
  };

  const continuationPage = (withTableHead: boolean): void => {
    page = doc.addPage([W, H]);
    band();
    y = H - 52;
    const half = contentWidth / 2 - 10;
    if (logo) {
      const scale = Math.min(LAYOUT.logoMaxWidth / 2 / logo.width, 18 / logo.height);
      page.drawImage(logo, { x: M, y: y - 4, width: logo.width * scale, height: logo.height * scale });
    } else {
      text(clip(bold, r.shop.name, 12, half).text, M, y, bold, 12, accent);
    }
    const head = `${L.title} ${r.number} \u00B7 ${L.continued}`;
    right(clip(bold, head, 10, half).text, W - M, y, bold, 10, MUTED);
    y -= 16;
    rule(y);
    y -= 24;
    if (withTableHead) tableHead();
  };

  /** Opens a continuation page unless `height` points fit above the footer zone. */
  const ensure = (height: number, inTable = false): void => {
    if (y - height < LAYOUT.contentBottom) continuationPage(inTable);
  };

  // ---- First page: shop on the left, document on the right ----
  band();
  const top = H - 44;
  const half = contentWidth / 2 - 10;
  let left = top;
  if (logo) {
    const scale = Math.min(LAYOUT.logoMaxWidth / logo.width, LAYOUT.logoMaxHeight / logo.height);
    const h = logo.height * scale;
    page.drawImage(logo, { x: M, y: top - h, width: logo.width * scale, height: h });
    left = top - h - 16;
    text(fitted(r.shop.name, bold, 12, half, 'shop.name'), M, left, bold, 12);
  } else {
    left = top - 20;
    text(fitted(r.shop.name, bold, 20, half, 'shop.name'), M, left, bold, 20, accent);
  }
  r.shop.lines.forEach((l, i) => {
    left -= 13;
    text(fitted(l, regular, 9, half, `shop.lines[${i}]`), M, left, regular, 9, MUTED);
  });
  let rightY = top - 18;
  right(L.title, W - M, rightY, bold, fitSize(bold, L.title, 18, half));
  rightY -= 18;
  right(fitted(r.number, regular, 11, half, 'number'), W - M, rightY, regular, 11, MUTED);
  rightY -= 15;
  right(clip(regular, `${L.date}: ${r.issuedText}`, 9, half).text, W - M, rightY, regular, 9, MUTED);

  y = Math.min(left, rightY) - 16;
  rule(y, 1);
  y -= 24;

  text(L.customer, M, y, bold, 9, MUTED);
  y -= 17;
  text(fitted(r.customer.name, bold, 14, contentWidth, 'customer.name'), M, y, bold, 14);
  r.customer.lines.forEach((l, i) => {
    y -= 15;
    text(fitted(l, regular, 10, contentWidth, `customer.lines[${i}]`), M, y, regular, 10, MUTED);
  });
  if (r.deliveryText !== null) {
    y -= 15;
    text(`${L.delivery}: ${r.deliveryText}`, M, y, regular, 10, INK);
  }
  y -= 28;

  // ---- Items, paginated, with the table head repeated on each continuation page ----
  tableHead();
  r.items.forEach((item, i) => {
    const name = wrap(regular, item.name, 10, col.nameWidth, ctx.maxNameLines);
    if (name.clipped) warn({ code: 'text_clipped', field: `items[${i}].name` });
    const height = LAYOUT.nameLineHeight * name.lines.length + LAYOUT.rowGap;
    ensure(height, true);
    name.lines.forEach((l, k) => text(l, col.nameLeft, y - LAYOUT.nameLineHeight * k, regular, 10));
    text(fitted(item.detail, regular, 9, col.detailWidth, `items[${i}].detail`), col.detailLeft, y, regular, 9, MUTED);
    amount(item.quantity, col.quantityRight, y, regular, 10, col.quantityWidth);
    amount(item.unitPrice, col.unitPriceRight, y, regular, 9, col.unitPriceWidth, MUTED);
    amount(item.lineTotal, col.lineTotalRight, y, bold, 10, col.totalsAmountWidth);
    // The separator sits in the gap under the last line of the row, never across text.
    rule(y - LAYOUT.nameLineHeight * (name.lines.length - 1) - 9, 0.4);
    y -= height;
  });

  // ---- Totals ----
  // The previous balance goes under the totals, labelled as not included: printed above the
  // total, anyone reading the paper assumes it was added. A shipping of 0 is printed (it says
  // shipping is free) but adds no grand total, which would repeat the same number.
  const shipping = r.shippingCents;
  const balance = r.previousBalanceCents;
  const hasShipping = shipping !== null;
  const hasGrandTotal = shipping !== null && shipping !== 0;
  const hasBalance = balance !== null && balance !== 0;
  // Reserve what will actually be drawn, so a long order with no extras is not pushed to a new
  // page to print an empty block.
  ensure(12 + 20 + (hasShipping ? 18 : 0) + (hasGrandTotal ? 22 : 0) + (hasBalance ? 30 : 0) + 12);
  y -= 12;
  const labelWidth = col.unitPriceRight - M - 10;
  const totalLabel = (s: string, font: PDFFont, size: number, color: RGB = INK): void =>
    right(clip(font, s, size, labelWidth).text, col.unitPriceRight, y, font, size, color);

  const itemsTotal = r.money(r.itemsTotalCents);
  totalLabel(hasGrandTotal ? L.itemsTotal : L.total, bold, 12);
  amount(itemsTotal, col.lineTotalRight, y, bold, hasGrandTotal ? 12 : 15, col.totalsAmountWidth, hasGrandTotal ? INK : accent);
  y -= 20;
  if (hasShipping) {
    totalLabel(L.shipping, regular, 10, MUTED);
    amount(r.money(shipping), col.lineTotalRight, y, regular, 10, col.totalsAmountWidth, MUTED);
    y -= 18;
  }
  if (hasGrandTotal) {
    rule(y + 14, 0.75, col.unitPriceRight - 70, col.lineTotalRight);
    totalLabel(L.grandTotal, bold, 12);
    amount(r.money(r.itemsTotalCents + shipping), col.lineTotalRight, y, bold, 15, col.totalsAmountWidth, accent);
    y -= 22;
  }
  if (hasBalance) {
    // A negative balance is a credit. "-$3.000" next to "Saldo anterior" reads two ways, so the
    // label changes and the sign goes.
    totalLabel(balance < 0 ? L.creditBalance : L.previousBalance, regular, 10, MUTED);
    amount(r.money(Math.abs(balance)), col.lineTotalRight, y, regular, 10, col.totalsAmountWidth, MUTED);
    y -= 12;
    right(clip(regular, L.balanceNotIncluded, 8, contentWidth).text, col.lineTotalRight, y, regular, 8, MUTED);
    y -= 18;
  }
  y -= 12;

  // ---- Notes: wrapped, and continued across pages in as many boxes as they need ----
  if (r.notes.length > 0) {
    const lines = r.notes.flatMap((p) => wrap(regular, p, 10, contentWidth - 12).lines);
    const lh = LAYOUT.noteLineHeight;
    let next = 0;
    let first = true;
    while (next < lines.length) {
      let room = Math.floor((y - 8 - LAYOUT.contentBottom - 30) / lh);
      if (room < 1) {
        continuationPage(false);
        room = Math.floor((y - 8 - LAYOUT.contentBottom - 30) / lh);
      }
      const chunk = lines.slice(next, next + room);
      const boxHeight = 30 + lh * chunk.length;
      page.drawRectangle({ x: M - 6, y: y - boxHeight + 12, width: contentWidth + 12, height: boxHeight, color: BAND });
      text(first ? L.notes : `${L.notes} (${L.continued})`, M, y, bold, 9);
      chunk.forEach((l, k) => text(l, M, y - 16 - lh * k, regular, 10));
      y -= boxHeight + 8;
      next += chunk.length;
      first = false;
    }
  }

  // ---- Footers, now that the page count is known ----
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    page = p;
    if (r.footer) text(clip(regular, r.footer, 9, contentWidth).text, M, LAYOUT.footerTextY, regular, 9, MUTED);
    rule(LAYOUT.footerRuleY, 0.5);
    const pageLabel = L.pageOf.replace('{page}', String(i + 1)).replace('{pages}', String(pages.length));
    text(clip(regular, r.shop.name, 8, contentWidth / 2 - 10).text, M, LAYOUT.footerSmallY, regular, 8, MUTED);
    right(clip(regular, pageLabel, 8, contentWidth / 2 - 10).text, W - M, LAYOUT.footerSmallY, regular, 8, MUTED);
  });
  if (r.footer && clip(regular, r.footer, 9, contentWidth).clipped) warn({ code: 'text_clipped', field: 'footer' });
}

