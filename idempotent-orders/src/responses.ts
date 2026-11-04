/**
 * The shapes the SQL functions answer with, validated before anything is reported to a caller.
 * A 2xx body that does not match is treated like a lost response: it is never read as success.
 */
import { z } from 'zod';

const id = z.number().int().positive();

const OrderRow = z.object({
  id,
  idempotency_key: z.string(),
  customer_id: z.string(),
  fingerprint: z.string(),
  status: z.enum(['pending', 'confirmed']),
  version: z.number().int().positive(),
  total_cents: z.number().int().nonnegative(),
  created_at: z.string(),
  confirmed_at: z.string().nullable(),
  confirm_key: z.string().nullable(),
  lines: z.array(
    z.object({
      product_id: id,
      quantity: z.number().int().positive(),
      unit_price_cents: z.number().int().nonnegative(),
    }),
  ),
});

export const OrderSchema = OrderRow.transform((o) => ({
  id: o.id,
  key: o.idempotency_key,
  customerId: o.customer_id,
  fingerprint: o.fingerprint,
  status: o.status,
  version: o.version,
  totalCents: o.total_cents,
  createdAt: o.created_at,
  confirmedAt: o.confirmed_at,
  confirmKey: o.confirm_key,
  lines: o.lines.map((l) => ({ productId: l.product_id, quantity: l.quantity, unitPriceCents: l.unit_price_cents })),
}));

/** An order as stored, as the functions return it. */
export type Order = z.output<typeof OrderSchema>;

export const PlaceResponse = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('placed'), order: OrderSchema }),
  z.object({ outcome: z.literal('already_placed'), order: OrderSchema }),
  z.object({ outcome: z.literal('key_reused'), order: OrderSchema }),
  z.object({ outcome: z.literal('key_expired'), why: z.enum(['age', 'not_pending']), order: OrderSchema }),
  z.object({ outcome: z.literal('key_taken') }),
  z.object({ outcome: z.literal('unavailable'), product_ids: z.array(id).min(1) }),
]);

export const FindResponse = z.discriminatedUnion('outcome', [
  /** within_window: the order is inside the resend window, as place_order judges it. */
  z.object({ outcome: z.literal('found'), within_window: z.boolean(), order: OrderSchema }),
  z.object({ outcome: z.literal('not_found') }),
  z.object({ outcome: z.literal('key_taken') }),
]);

const Shortage = z
  .object({ product_id: id, requested: z.number().int().positive(), on_hand: z.number().int().nonnegative() })
  .transform((s) => ({ productId: s.product_id, requested: s.requested, onHand: s.on_hand }));

export const ConfirmResponse = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('confirmed'), order: OrderSchema }),
  z.object({ outcome: z.literal('already_confirmed'), order: OrderSchema }),
  z.object({ outcome: z.literal('not_found') }),
  z.object({ outcome: z.literal('not_pending'), status: z.string() }),
  z.object({ outcome: z.literal('version_conflict'), current_version: z.number().int().positive() }),
  z.object({ outcome: z.literal('insufficient_stock'), shortages: z.array(Shortage).min(1) }),
]);

export const GetResponse = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('found'), order: OrderSchema }),
  z.object({ outcome: z.literal('not_found') }),
]);
