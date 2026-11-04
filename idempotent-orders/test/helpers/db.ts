/**
 * A real Postgres (PGlite, in process) with sql/schema.sql applied, set up the way Supabase sets up a
 * project: the anon, authenticated and service_role roles exist, and default privileges grant them
 * every new table, sequence and function. The schema's revokes are therefore tested against the
 * grants they exist to undo.
 */
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

export const SCHEMA_SQL = readFileSync(new URL('../../sql/schema.sql', import.meta.url), 'utf8');

const SUPABASE_LIKE_ROLES = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
`;

export async function openDb(): Promise<PGlite> {
  const db = await PGlite.create();
  await db.exec(SUPABASE_LIKE_ROLES);
  await db.exec(SCHEMA_SQL);
  return db;
}

export async function resetDb(db: PGlite): Promise<void> {
  await db.exec('truncate order_lines, orders, stock, products restart identity cascade');
}

export interface ProductSeed {
  readonly name: string;
  readonly priceCents: number;
  readonly onHand: number;
  readonly active?: boolean;
}

/** Inserts products with their stock rows and returns their ids, in order, one per seed. */
export async function seedProducts<const T extends readonly ProductSeed[]>(db: PGlite, products: T): Promise<{ -readonly [K in keyof T]: number }> {
  const ids: number[] = [];
  for (const p of products) {
    const row = await db.query<{ id: number }>(
      'insert into products (name, price_cents, active) values ($1, $2, $3) returning id',
      [p.name, p.priceCents, p.active ?? true],
    );
    const id = Number(row.rows[0]?.id);
    await db.query('insert into stock (product_id, on_hand) values ($1, $2)', [id, p.onHand]);
    ids.push(id);
  }
  return ids as { -readonly [K in keyof T]: number };
}

/** The jsonb a function returned, as an object. */
export async function call(db: PGlite, sql: string, params: readonly unknown[]): Promise<Record<string, unknown>> {
  const result = await db.query<{ r: Record<string, unknown> }>(sql, [...params]);
  const r = result.rows[0]?.r;
  if (r === undefined) throw new Error('the function returned no row');
  return r;
}

export type SqlLine = { product_id: number; quantity: number };

export const place = (db: PGlite, key: string, customer: string, lines: readonly SqlLine[]) =>
  call(db, 'select place_order($1, $2, $3::jsonb) as r', [key, customer, JSON.stringify(lines)]);

export const findOrder = (db: PGlite, key: string, customer: string) =>
  call(db, 'select find_order($1, $2) as r', [key, customer]);

export const edit = (db: PGlite, orderId: number, version: number, lines: readonly SqlLine[]) =>
  call(db, 'select edit_order($1, $2, $3::jsonb) as r', [orderId, version, JSON.stringify(lines)]);

export const confirm = (db: PGlite, orderId: number, version: number, key: string) =>
  call(db, 'select confirm_order($1, $2, $3) as r', [orderId, version, key]);

export async function count(db: PGlite, table: 'orders' | 'order_lines' | 'products' | 'stock'): Promise<number> {
  const r = await db.query<{ n: number }>(`select count(*)::int as n from ${table}`);
  return Number(r.rows[0]?.n);
}

export async function onHand(db: PGlite, productId: number): Promise<number> {
  const r = await db.query<{ on_hand: number }>('select on_hand from stock where product_id = $1', [productId]);
  return Number(r.rows[0]?.on_hand);
}

/** A fresh key in the format the functions accept. */
export const key = (): string => crypto.randomUUID();

/** The order inside a function's answer. */
export function orderOf(r: Record<string, unknown>): { id: number; version: number; status: string; [k: string]: unknown } {
  const order = r['order'];
  if (typeof order !== 'object' || order === null) throw new Error(`no order in ${JSON.stringify(r)}`);
  return order as { id: number; version: number; status: string };
}

/**
 * Reproduces the race that `exception when unique_violation` exists for, in a database with one
 * connection. PGlite runs one backend, so two calls never overlap and the lookup always sees a
 * committed order. Here `products` becomes a view whose filter, the first time place_order reads
 * it (after its lookup by key, before its insert), inserts a twin order under the same key: what
 * a second transaction committing in that gap looks like to the first. The twin is written in the
 * calling transaction but outside the insert's subtransaction, so it survives the rollback of the
 * failed insert, as a committed order would. Returns a function that undoes it.
 */
export async function injectTwinAfterLookup(
  db: PGlite,
  twin: { key: string; customer: string; lines: readonly SqlLine[] },
): Promise<() => Promise<void>> {
  await db.exec(`
    create table race_twin (key text not null, customer text not null, lines jsonb not null);
    alter table products rename to products_base;
    create function race_hook() returns boolean language plpgsql volatile as $hook$
    declare
      t race_twin;
      v_id bigint;
    begin
      delete from race_twin returning * into t;
      if t.key is not null then
        insert into orders (idempotency_key, customer_id, fingerprint, total_cents)
        values (t.key, t.customer, order_fingerprint(t.lines), 0) returning id into v_id;
        insert into order_lines (order_id, product_id, quantity, unit_price_cents)
        select v_id, (l->>'product_id')::bigint, (l->>'quantity')::int, 0 from jsonb_array_elements(t.lines) as l;
      end if;
      return true;
    end $hook$;
    create view products as select * from products_base where race_hook();
  `);
  await db.query('insert into race_twin values ($1, $2, $3::jsonb)', [twin.key, twin.customer, JSON.stringify(twin.lines)]);
  return async () => {
    await db.exec(`
      drop view products;
      alter table products_base rename to products;
      drop function race_hook();
      drop table race_twin;
    `);
  };
}
