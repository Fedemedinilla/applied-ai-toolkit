// The copy of apps/writer/evals/specifics.ts stays a copy: the fences keep prose-rewriter from
// importing an app, so this test reads both files as text and compares what was copied.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { specifics } from '../src/specifics.ts';

const REPO = join(import.meta.dirname, '..', '..');
const read = (path: string) => readFileSync(join(REPO, path), 'utf8');
const ORIGINAL = read('apps/writer/evals/specifics.ts');
const COPY = read('prose-rewriter/src/specifics.ts');

/** The source of one top-level declaration, from its first line to the first line that closes it. */
function declaration(source: string, start: RegExp): string {
  const lines = source.split('\n');
  const first = lines.findIndex((l) => start.test(l));
  if (first < 0) throw new Error(`not found: ${start}`);
  const last = lines.findIndex((l, i) => i >= first && /^\};?$/u.test(l));
  return lines
    .slice(first, last + 1)
    .join('\n')
    .replace(/^export /u, '');
}

describe('the copy of specifics()', () => {
  it('has the same body as the original', () => {
    const fn = /^export function specifics\(/u;
    expect(declaration(COPY, fn)).toBe(declaration(ORIGINAL, fn));
  });

  it('has the same patterns, placeholder included, and the same asTime', () => {
    for (const name of ['TIME', 'EMAIL', 'URL_LIKE', 'NUMBER', 'PLACEHOLDER_ANY']) {
      const line = (source: string) => source.split('\n').find((l) => l.startsWith(`const ${name} =`));
      expect(line(COPY), name).toBeDefined();
      expect(line(COPY), name).toBe(line(ORIGINAL));
    }
    const asTime = /^(?:export )?const asTime =/u;
    expect(declaration(COPY, asTime)).toBe(declaration(ORIGINAL, asTime));
  });

  it('never reads a placeholder as a specific', () => {
    expect(specifics('Llego a las 15:00 [COMPLETAR: 12 pedidos por semana, a las 9:30].')).toEqual([{ kind: 'time', text: '15:00' }]);
  });
});
