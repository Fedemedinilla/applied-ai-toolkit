// The package boundary: the CLI's output, and that src/ can be bundled for a browser.

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const cli = fileURLToPath(new URL('../cli.ts', import.meta.url));
const src = fileURLToPath(new URL('../src/', import.meta.url));

function run(args: string[], input?: string): unknown[] {
  const out = execFileSync(process.execPath, [cli, ...args], { input: input ?? '', encoding: 'utf8' });
  return out.trim().split('\n').map((line) => JSON.parse(line) as unknown);
}

describe('cli', () => {
  it('reads stdin, one JSON object per line', () => {
    const [sale, cakes] = run([], 'vendí 3 docenas a 12 mil la docena\n\nvendí 5 tortas a 8000\n') as Array<Record<string, unknown>>;
    expect(sale).toMatchObject({
      value: 36_000,
      ambiguous: false,
      reason: null,
      quantity: 3,
      unitPrice: 12_000,
      spans: [
        { start: 6, end: 7, text: '3', role: 'quantity' },
        { start: 18, end: 24, text: '12 mil', role: 'unit_price' },
      ],
    });
    expect(cakes).toMatchObject({ value: null, ambiguous: true, reason: 'unit_or_total' });
  });

  it('reads arguments, and reports a sentence with no amount', () => {
    expect(run(['pagué la luz'])).toEqual([
      {
        input: 'pagué la luz',
        value: null,
        ambiguous: false,
        reason: null,
        approximate: false,
        quantity: null,
        unitPrice: null,
        literal: null,
        source: null,
        spans: [],
      },
    ]);
  });

  it('prints the same keys for every kind of answer', () => {
    const lines = run(['gasté 20 lucas', 'vendí 5 tortas a 8000', 'hola']) as Array<Record<string, unknown>>;
    const keys = lines.map((line) => Object.keys(line).sort());
    expect(keys[1]).toEqual(keys[0]);
    expect(keys[2]).toEqual(keys[0]);
  });
});

describe('src/ is browser-safe', () => {
  it('imports nothing but its own files', () => {
    for (const file of readdirSync(src)) {
      const code = readFileSync(src + file, 'utf8');
      // The TypeScript scanner, not a regex: it skips comments and strings, and reports static,
      // side-effect and dynamic imports and re-exports, with either quote.
      const specifiers = ts.preProcessFile(code, true, true).importedFiles.map((f) => f.fileName);
      expect(specifiers.length, file).toBeGreaterThanOrEqual(file === 'vocabulary.ts' ? 0 : 1);
      for (const s of specifiers) expect(s, `${file} imports ${s}`).toMatch(/^\.\/[a-z-]+\.ts$/u);
      expect(code, file).not.toMatch(/\bprocess\.|\brequire\(|import\.meta/u);
      // Safari before 16.4 rejects a regex lookbehind when it parses the file, and then nothing in
      // the module runs.
      expect(code, file).not.toMatch(/\(\?<[=!]/u);
    }
  });
});
