import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { LintResult } from '../src/types.ts';

const cli = fileURLToPath(new URL('../cli.ts', import.meta.url));
const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/cover-letters/${name}`, import.meta.url));
const run = (args: string[], input?: string) =>
  spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', ...(input === undefined ? {} : { input }) });

describe('cli', () => {
  it('exits 1 when a tier 1 rule fires and prints file:line:column', () => {
    const r = run([fixture('en-before.txt'), '--lang', 'en']);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/en-before\.txt:2:1 {2,}L1 high +LEX-03/);
    expect(r.stdout).toMatch(/fails tier 1/);
  });

  it('exits 0 when only level 2 findings remain', () => {
    const r = run([fixture('en-after.txt'), '--lang=en']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/passes tier 1/);
  });

  it('prints the full result as JSON', () => {
    const r = run([fixture('es-rioplatense-before.txt'), '--lang', 'es', '--json']);
    expect(r.status).toBe(1);
    const result = JSON.parse(r.stdout) as LintResult;
    expect(result.lang).toBe('es');
    expect(result.passesTier1).toBe(false);
    expect(result.findings.some((f) => f.ruleId === 'EST-01')).toBe(true);
  });

  it('reads stdin with "-" and takes anchors', () => {
    expect(run(['-', '--lang', 'es'], 'Uso airflow con el equipo. Me gusta el equipo.').stdout).toMatch(/LEX-07/);
    const r = run(['-', '--lang', 'es', '--anchors', 'airflow'], 'Uso airflow con el equipo.');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^0 findings/);
  });

  it('exits 2 on bad usage or a missing file', () => {
    expect(run([fixture('en-after.txt')]).status).toBe(2);
    expect(run([fixture('en-after.txt'), '--lang', 'fr']).status).toBe(2);
    expect(run(['does-not-exist.txt', '--lang', 'en']).status).toBe(2);
    expect(run([fixture('en-after.txt'), '--lang', 'en', '--format', 'html']).status).toBe(2);
    expect(run(['-', '-', '--lang', 'en'], 'Text.').status).toBe(2);
  });

  describe('--format', () => {
    const dir = mkdtempSync(join(tmpdir(), 'slop-lint-cli-'));
    const doc = '# Notes\n\n- First item.\n- Second item.\n\n```\nI am passionate about data.\n```\n';
    const mdFile = join(dir, 'notes.md');
    const txtFile = join(dir, 'notes.txt');
    writeFileSync(mdFile, doc);
    writeFileSync(txtFile, doc);

    it('reads a .md file as Markdown when no format is given', () => {
      const r = run([mdFile, '--lang', 'en']);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('0 findings (L1 0, L2 0, L3 0); slop score 15/15; passes tier 1\n');
    });

    it('reads any other file, and stdin, as text', () => {
      expect(run([txtFile, '--lang', 'en']).stdout).toMatch(/FMT-01[\s\S]*LEX-03/);
      expect(run(['-', '--lang', 'en'], doc).stdout).toMatch(/FMT-01/);
    });

    it('lets --format override the extension either way', () => {
      expect(run([mdFile, '--lang', 'en', '--format', 'text']).status).toBe(1);
      expect(run([txtFile, '--lang', 'en', '--format=markdown']).status).toBe(0);
      expect(run(['-', '--lang', 'en', '--format', 'markdown'], doc).status).toBe(0);
    });

    it('lints several files, with one summary line each, and exits 1 if any fails', () => {
      const r = run([mdFile, txtFile, '--lang', 'en']);
      expect(r.status).toBe(1);
      const summaries = r.stdout.split('\n').filter((l) => / findings \(/u.test(l));
      expect(summaries).toEqual([
        `${mdFile}: 0 findings (L1 0, L2 0, L3 0); slop score 15/15; passes tier 1`,
        expect.stringMatching(new RegExp(`^${txtFile.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}: \\d+ findings .*fails tier 1$`, 'u')),
      ]);
      expect(run([mdFile, mdFile, '--lang', 'en']).status).toBe(0);
    });
  });
});
