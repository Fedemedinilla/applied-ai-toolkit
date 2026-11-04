import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Row } from '../src/entry.ts';
import { BACKUP_PREFIX, loadRows, saveRows, STORAGE_KEY, type KeyValue } from '../src/storage.ts';
import { corpusLines, families, filterLines, readCorpus, REASON_LABEL } from '../src/corpus.ts';

class MemoryStore implements KeyValue {
  data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

const good: Row = {
  id: 'a',
  at: '2026-11-04T12:00:00.000Z',
  kind: 'income',
  amount: 36000,
  category: 'Ventas',
  keyword: null,
  sentence: 'vendí 3 docenas a 12 mil la docena',
  literal: '3 x 12 mil',
  approximate: false,
};

describe('storage', () => {
  it('round-trips rows', () => {
    const store = new MemoryStore();
    expect(saveRows(store, [good])).toBe(true);
    expect(loadRows(store, 't')).toEqual({ rows: [good], dropped: 0, available: true, backupKey: null, writable: true });
    // A clean load makes no backup.
    expect([...store.data.keys()]).toEqual([STORAGE_KEY]);
  });

  it('keeps the model-mode fields and drops rows where they are malformed', () => {
    const store = new MemoryStore();
    const dated: Row = { ...good, id: 'm', day: '2026-11-03', via: 'model' };
    store.setItem(STORAGE_KEY, JSON.stringify([dated, { ...dated, id: 'x', day: 'ayer' }, { ...dated, id: 'y', via: 'magic' }]));
    const loaded = loadRows(store, 't');
    expect(loaded.rows).toEqual([dated]);
    expect(loaded.dropped).toBe(2);
  });

  it('leaves out entries that are not rows, counts them, and keeps a copy of the raw text', () => {
    const store = new MemoryStore();
    const raw = JSON.stringify([good, { ...good, amount: -5 }, { ...good, category: 'Inventada' }, { ...good, at: 'ayer' }, 'texto', null]);
    store.setItem(STORAGE_KEY, raw);
    const backupKey = `${BACKUP_PREFIX}1700000000000`;
    expect(loadRows(store, '1700000000000')).toEqual({ rows: [good], dropped: 5, available: true, backupKey, writable: true });
    expect(store.getItem(backupKey)).toBe(raw);
  });

  it('survives text that is not JSON or not an array, and keeps it', () => {
    const store = new MemoryStore();
    store.setItem(STORAGE_KEY, '{oops');
    expect(loadRows(store, 'a')).toMatchObject({ rows: [], dropped: 1, available: true, writable: true });
    expect(store.getItem(`${BACKUP_PREFIX}a`)).toBe('{oops');
    store.setItem(STORAGE_KEY, '{"a":1}');
    expect(loadRows(store, 'b')).toMatchObject({ rows: [], dropped: 1, writable: true });
    expect(store.getItem(`${BACKUP_PREFIX}b`)).toBe('{"a":1}');
  });

  it('refuses to write when the copy cannot be made, so the unread text is never overwritten', () => {
    const readOnly: KeyValue = {
      getItem: () => '{oops',
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    expect(loadRows(readOnly, 'c')).toEqual({ rows: [], dropped: 1, available: true, backupKey: null, writable: false });
  });

  it('reports storage that throws, on read and on write', () => {
    const broken: KeyValue = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    expect(loadRows(broken, 't')).toMatchObject({ rows: [], dropped: 0, available: false });
    expect(saveRows(broken, [good])).toBe(false);
    expect(loadRows(null, 't').available).toBe(false);
    expect(saveRows(null, [good])).toBe(false);
  });
});

describe('corpus tab data', () => {
  const raw: unknown = JSON.parse(readFileSync(new URL('../../../amount-parser/corpus/corpus.json', import.meta.url), 'utf8'));
  const cases = readCorpus(raw);
  const lines = corpusLines(cases);

  it('reads all 165 phrases in 15 families', () => {
    expect(cases).toHaveLength(165);
    expect(families(cases)).toHaveLength(15);
  });

  it('the parser agrees with every phrase except the documented known conflict', () => {
    const differ = lines.filter((l) => !l.agrees);
    expect(differ.map((l) => l.case.phrase)).toEqual(['compre 2 sillas de plastico 45 mil']);
    expect(differ[0]?.case.known_conflict).toBeTypeOf('string');
  });

  it('drops malformed cases instead of throwing', () => {
    expect(readCorpus({ not: 'an array' })).toEqual([]);
    expect(readCorpus([{ phrase: 'x' }, null, 3])).toEqual([]);
  });

  it('filters by folded text, family and "asks only"', () => {
    const dollars = filterLines(lines, { text: 'DÓLARES', family: '', asksOnly: false });
    // The third one says "usd"; its note says "dolares", and the filter searches notes too.
    expect(dollars.map((l) => l.case.phrase)).toEqual([
      'vendi la camioneta en 20 mil dolares',
      'pague 15 mil dolares de la maquina nueva',
      'me pagaron 800 usd por el trabajo',
    ]);
    const iva = filterLines(lines, { text: '', family: 'tax-and-discounts', asksOnly: true });
    expect(iva.length).toBeGreaterThan(0);
    expect(iva.every((l) => l.case.family === 'tax-and-discounts' && l.parsed?.ambiguous)).toBe(true);
    expect(filterLines(lines, { text: '', family: '', asksOnly: false })).toHaveLength(165);
  });
});

describe('corpus tab labels', () => {
  it('names every ambiguity reason in Spanish, never by its identifier', () => {
    for (const [reason, label] of Object.entries(REASON_LABEL)) {
      expect(label).not.toBe(reason);
      expect(label).not.toMatch(/_/u);
    }
    const asking = corpusLines(readCorpus([{ phrase: 'vendí 5 tortas a 8000', family: 'x', kind: 'income', total: null, ambiguous: true, note: '' }]));
    expect(asking[0]?.got).toBe('pregunta (precio por unidad o total)');
  });
});
