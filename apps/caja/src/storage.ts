// Rows live in localStorage, under one key, as a JSON array.
//
// localStorage can throw (Safari private mode, a full quota, storage blocked by the user) and can
// hold anything (an older version of this app, a hand edit). So every read is validated row by
// row, and a row that does not have the shape is left out instead of breaking the list. Left out
// of the list is not deleted: before the app writes anything, the raw stored text is copied to a
// backup key, because the next save replaces the whole array. If the copy cannot be made, the
// app does not write at all. A failed write is reported to the screen instead of being
// swallowed: the owner has to know that the sale they just typed will not be there tomorrow.

import { EXPENSE_CATEGORIES, INCOME_CATEGORIES, type Category } from './categories.ts';
import type { Row } from './entry.ts';

export const STORAGE_KEY = 'caja.rows.v1';
/** Prefix of the keys that keep a copy of stored text that did not load cleanly. */
export const BACKUP_PREFIX = `${STORAGE_KEY}.corrupt-`;

/** The part of the Storage interface this module uses, so tests can pass a fake. */
export interface KeyValue {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const CATEGORIES: ReadonlySet<string> = new Set([...INCOME_CATEGORIES, ...EXPENSE_CATEGORIES]);

function isRow(value: unknown): value is Row {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r['id'] === 'string' &&
    typeof r['at'] === 'string' &&
    !Number.isNaN(Date.parse(r['at'])) &&
    (r['kind'] === 'income' || r['kind'] === 'expense') &&
    typeof r['amount'] === 'number' &&
    Number.isFinite(r['amount']) &&
    r['amount'] > 0 &&
    typeof r['category'] === 'string' &&
    CATEGORIES.has(r['category'] as Category) &&
    (r['keyword'] === null || typeof r['keyword'] === 'string') &&
    typeof r['sentence'] === 'string' &&
    typeof r['literal'] === 'string' &&
    typeof r['approximate'] === 'boolean' &&
    (r['day'] === undefined || (typeof r['day'] === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(r['day']))) &&
    (r['via'] === undefined || r['via'] === 'model')
  );
}

export interface LoadResult {
  rows: Row[];
  /** Entries in storage that were not valid rows and were left out of `rows`. */
  dropped: number;
  /** False when storage could not be read at all. */
  available: boolean;
  /** The key holding a copy of the raw stored text, when something was left out. */
  backupKey: string | null;
  /** False when something was left out and no copy could be made: writing would destroy it. */
  writable: boolean;
}

const UNAVAILABLE: LoadResult = { rows: [], dropped: 0, available: false, backupKey: null, writable: false };

/** Reads every row it can. `stamp` names the backup key, so tests get a stable one. */
export function loadRows(store: KeyValue | null, stamp: string): LoadResult {
  if (!store) return UNAVAILABLE;
  let raw: string | null;
  try {
    raw = store.getItem(STORAGE_KEY);
  } catch {
    return UNAVAILABLE;
  }
  if (raw === null) return { rows: [], dropped: 0, available: true, backupKey: null, writable: true };
  let rows: Row[] = [];
  let dropped = 1;
  try {
    const data: unknown = JSON.parse(raw);
    if (Array.isArray(data)) {
      rows = data.filter(isRow);
      dropped = data.length - rows.length;
    }
  } catch {
    // Not JSON: nothing loads, and the whole text is kept in the backup below.
  }
  if (dropped === 0) return { rows, dropped, available: true, backupKey: null, writable: true };
  const backupKey = `${BACKUP_PREFIX}${stamp}`;
  try {
    store.setItem(backupKey, raw);
    return { rows, dropped, available: true, backupKey, writable: true };
  } catch {
    return { rows, dropped, available: true, backupKey: null, writable: false };
  }
}

/** True when the rows were written. */
export function saveRows(store: KeyValue | null, rows: readonly Row[]): boolean {
  if (!store) return false;
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(rows));
    return true;
  } catch {
    return false;
  }
}

/** window.localStorage, or null when even touching the property throws. */
export function browserStorage(): KeyValue | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
