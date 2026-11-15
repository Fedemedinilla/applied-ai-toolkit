import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { freshOutput, readJsonl } from '../src/files.ts';

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

describe('freshOutput', () => {
  it('creates an empty file and refuses one that exists, leaving it as it was', () => {
    const path = join(dir, 'new.jsonl');
    expect(freshOutput(path)).toBe(path);
    expect(readFileSync(path, 'utf8')).toBe('');
    const old = file('old.jsonl', '{"a":1}\n');
    expect(() => freshOutput(old)).toThrow(`${old} already exists; pick a new file so two runs never mix`);
    expect(readFileSync(old, 'utf8')).toBe('{"a":1}\n');
  });
});
