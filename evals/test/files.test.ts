import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readJsonl } from '../src/files.ts';

const dir = mkdtempSync(join(tmpdir(), 'evals-files-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const file = (name: string, content: string) => {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
};

describe('readJsonl', () => {
  it('names the line of the file, counting blank lines', () => {
    const path = file('blank.jsonl', '{"a":1}\n\n\n{bad\n');
    expect(() => readJsonl(path)).toThrow(`${path}:4: not JSON`);
    expect(readJsonl(file('ok.jsonl', '{"a":1}\n\n{"a":2}\n'))).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('reads a file that starts with a byte order mark', () => {
    expect(readJsonl(file('bom.jsonl', '﻿{"a":1}\n'))).toEqual([{ a: 1 }]);
  });
});
