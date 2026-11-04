// Records every drawText call made while `fn` runs, the way the source app's regression script
// checked its delivery notes: what was printed, where, at what size and in which font. Pages are
// numbered in the order they first receive text, which is the order they were added, because
// every page draws its header as soon as it is created.

import { PDFPage, type PDFPageDrawTextOptions } from 'pdf-lib';

export interface Drawn {
  readonly page: number;
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly font: string;
  /** The text's width at its size in its font, measured the way the layout measures it. */
  readonly width: number;
}

export async function record<T>(fn: () => Promise<T>): Promise<{ result: T; drawn: Drawn[] }> {
  const real = PDFPage.prototype.drawText;
  const pages = new Map<PDFPage, number>();
  const drawn: Drawn[] = [];
  PDFPage.prototype.drawText = function (this: PDFPage, text: string, options: PDFPageDrawTextOptions = {}): void {
    let page = pages.get(this);
    if (page === undefined) {
      page = pages.size;
      pages.set(this, page);
    }
    const size = options.size ?? 24;
    drawn.push({
      page,
      text,
      x: options.x ?? 0,
      y: options.y ?? 0,
      size,
      font: options.font?.name ?? '',
      width: options.font ? options.font.widthOfTextAtSize(text, size) : 0,
    });
    real.call(this, text, options);
  };
  try {
    return { result: await fn(), drawn };
  } finally {
    PDFPage.prototype.drawText = real;
  }
}

/** Texts that look like money: "$8.000", "-$4.500". */
export const amounts = (drawn: readonly Drawn[]): Drawn[] => drawn.filter((d) => /^-?\$/.test(d.text));

export const texts = (drawn: readonly Drawn[]): string => drawn.map((d) => d.text).join(' | ');

export const pageCount = (drawn: readonly Drawn[]): number => Math.max(-1, ...drawn.map((d) => d.page)) + 1;
