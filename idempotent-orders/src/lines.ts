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
  if (lines.length < 1 || lines.length > MAX_LINES) return `an order has 1 to ${MAX_LINES} lines`;
  const seen = new Set<number>();
  for (const line of lines) {
    if (!Number.isSafeInteger(line.productId) || line.productId < 1 || line.productId > MAX_PRODUCT_ID) {
      return 'every productId is a positive integer';
    }
    if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > MAX_QUANTITY) {
      return `every quantity is an integer from 1 to ${MAX_QUANTITY}`;
    }
    if (seen.has(line.productId)) return `product ${line.productId} appears twice`;
    seen.add(line.productId);
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
