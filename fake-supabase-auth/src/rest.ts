/**
 * A small PostgREST stand-in for reads: GET /rest/v1/<table> with `select` (plain column lists),
 * `eq` filters and `limit`, plus the single-object Accept header that `.single()` sends, on the
 * public schema. Anything else (another Accept such as `.csv()`, another schema through
 * `.schema()`) answers 501 with code `not_in_fake`, so a test that needs more fails loudly and writes its
 * own handler instead of getting a plausible wrong answer.
 */
import type { RecordedRequest, RestHandler } from './fake-auth.ts';

export type Row = Readonly<Record<string, unknown>>;

const SINGLE_OBJECT = 'application/vnd.pgrst.object+json';
/** The Accept values restTables answers: none, plain JSON, any, or the single object of `.single()`. */
const ACCEPTED = new Set([null, 'application/json', '*/*', SINGLE_OBJECT]);

export function notInFake(what: string): Response {
  return Response.json({ code: 'not_in_fake', message: `The fake does not emulate ${what}` }, { status: 501 });
}

function project(row: Row, columns: readonly string[] | null): Row {
  if (columns === null) return row;
  return Object.fromEntries(columns.map((column) => [column, row[column] ?? null]));
}

/**
 * A RestHandler that serves these rows. The tables are read at request time, so a test can change
 * them between calls.
 */
export function restTables(tables: Readonly<Record<string, readonly Row[]>>): RestHandler {
  return (request: RecordedRequest) => {
    if (request.method !== 'GET') return notInFake(`${request.method} on PostgREST`);
    const prefer = request.headers.get('prefer') ?? '';
    if (/\bcount=/.test(prefer)) return notInFake(`counts (Prefer: ${prefer})`);
    const accept = request.headers.get('accept');
    if (!ACCEPTED.has(accept)) return notInFake(`the response format ${accept}`);
    for (const name of ['accept-profile', 'content-profile']) {
      const profile = request.headers.get(name);
      if (profile !== null && profile !== 'public') return notInFake(`the schema ${profile} (${name})`);
    }
    const table = request.path.slice('/rest/v1/'.length);
    const rows = tables[table];
    if (rows === undefined) {
      return Response.json(
        { code: 'PGRST205', details: null, hint: null, message: `Could not find the table 'public.${table}' in the schema cache` },
        { status: 404 },
      );
    }

    let columns: string[] | null = null;
    let limit: number | null = null;
    const filters: Array<[string, string]> = [];
    for (const [key, value] of request.query) {
      if (key === 'select') {
        if (/[():!]/.test(value)) return notInFake('embedded resources, casts or renamed columns in select');
        columns = value === '*' ? null : value.split(',').map((c) => c.trim());
      } else if (key === 'limit') {
        const n = Number(value);
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(n)) return notInFake(`the limit ${value}`);
        limit = n;
      } else if (key === 'order' || key === 'offset' || key === 'or' || key === 'and') {
        return notInFake(`the ${key} parameter`);
      } else if (value.startsWith('eq.')) {
        filters.push([key, value.slice(3)]);
      } else {
        return notInFake(`the filter ${key}=${value}`);
      }
    }

    let result = rows.filter((row) => filters.every(([column, expected]) => row[column] !== undefined && String(row[column]) === expected));
    if (limit !== null) result = result.slice(0, limit);
    const projected = result.map((row) => project(row, columns));

    if (accept === SINGLE_OBJECT) {
      if (projected.length !== 1) {
        return Response.json(
          {
            code: 'PGRST116',
            details: `The result contains ${projected.length} rows`,
            hint: null,
            message: 'Cannot coerce the result to a single JSON object',
          },
          { status: 406 },
        );
      }
      return Response.json(projected[0]);
    }
    return Response.json(projected);
  };
}
