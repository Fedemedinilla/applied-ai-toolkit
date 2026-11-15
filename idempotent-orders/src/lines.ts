/** One line of an order as the caller sends it. Prices are not part of a request: the database reads them. */
export interface OrderLine {
  readonly productId: number;
  readonly quantity: number;
}

/** The same limits as `validate_lines` in sql/schema.sql. */
export const MAX_LINES = 200;
export const MAX_QUANTITY = 9999;
const MAX_PRODUCT_ID = 9_007_199_254_740_991;

/**
 * Why a line list would be refused by the database, or null when it would pass. Checked before
 * sending so a request that can only fail never goes out, and never spends a retry.
 */
export function linesProblem(lines: readonly OrderLine[]): string | null {
  // The lines often come straight from request JSON, so the shape is checked before any field.
  const untrusted: unknown = lines;
  if (!Array.isArray(untrusted) || untrusted.length < 1 || untrusted.length > MAX_LINES) return `an order has 1 to ${MAX_LINES} lines`;
  const seen = new Set<number>();
  for (const line of untrusted as readonly unknown[]) {
    if (typeof line !== 'object' || line === null) return 'every line is an object with productId and quantity';
    const { productId, quantity } = line as Record<string, unknown>;
    if (typeof productId !== 'number' || !Number.isSafeInteger(productId) || productId < 1 || productId > MAX_PRODUCT_ID) {
      return 'every productId is a positive integer';
    }
    if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
      return `every quantity is an integer from 1 to ${MAX_QUANTITY}`;
    }
    if (seen.has(productId)) return `product ${productId} appears twice`;
    seen.add(productId);
  }
  return null;
}

/**
 * product x quantity, ordered by product id: `3x2,10x1`. The same string as `order_fingerprint`
 * in sql/schema.sql (a test checks the two agree), so a re-read can tell the same order from a
 * changed one without another round trip.
 */
export function fingerprint(lines: readonly OrderLine[]): string {
  return [...lines]
    .sort((a, b) => a.productId - b.productId)
    .map((l) => `${l.productId}x${l.quantity}`)
    .join(',');
}

/** The lines in the JSON shape the SQL functions take. */
export function toSqlLines(lines: readonly OrderLine[]): { product_id: number; quantity: number }[] {
  return lines.map((l) => ({ product_id: l.productId, quantity: l.quantity }));
}
