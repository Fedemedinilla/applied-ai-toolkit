#!/usr/bin/env node
// Usage: node slop-lint/cli.ts <file|-> [file...] --lang en|es [--format text|markdown] [--json] [--anchors "dbt,pandas,Contoso Agro"]
// A file ending in .md is read as Markdown unless --format says otherwise; anything else, stdin included, as text.
// With several files, each one's findings are followed by its own summary line, prefixed with its name.
// Exit codes: 0 no level 1 finding, 1 at least one level 1 finding in any file, 2 bad usage or unreadable input.
import { readFileSync } from 'node:fs';
import { lint } from './src/lint.ts';
import type { Finding, Format, Lang, LintOptions, LintResult } from './src/types.ts';

const USAGE = 'usage: node slop-lint/cli.ts <file|-> [file...] --lang en|es [--format text|markdown] [--json] [--anchors a,b,c]';

interface Args {
  files: string[];
  lang: Lang;
  format: Format | undefined;
  json: boolean;
  anchors: string[];
}

function parseArgs(argv: readonly string[]): Args | string {
  const files: string[] = [];
  let lang: string | undefined;
  let format: string | undefined;
  let json = false;
  let anchors: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '--json') json = true;
    else if (arg === '--lang') lang = argv[++i];
    else if (arg.startsWith('--lang=')) lang = arg.slice('--lang='.length);
    else if (arg === '--format') format = argv[++i];
    else if (arg.startsWith('--format=')) format = arg.slice('--format='.length);
    else if (arg === '--anchors') anchors = (argv[++i] ?? '').split(',');
    else if (arg.startsWith('--anchors=')) anchors = arg.slice('--anchors='.length).split(',');
    else if (arg === '-' || !arg.startsWith('-')) files.push(arg);
    else return `unknown option ${arg}`;
  }
  if (files.length === 0) return 'missing input file';
  if (files.filter((f) => f === '-').length > 1) return 'stdin can be read only once';
  if (lang !== 'en' && lang !== 'es') return '--lang must be en or es';
  if (format !== undefined && format !== 'text' && format !== 'markdown') return '--format must be text or markdown';
  return { files, lang, format, json, anchors: anchors.map((a) => a.trim()).filter(Boolean) };
}

/** --format when given; otherwise Markdown for a .md file and text for anything else, stdin included. */
function formatFor(file: string, explicit: Format | undefined): Format {
  return explicit ?? (file !== '-' && file.toLowerCase().endsWith('.md') ? 'markdown' : 'text');
}

const location = (file: string, f: Finding): string => `${file}:${f.line}:${f.column}`;

/** One finding in the editor-friendly file:line:col form, padded so the columns line up. */
function formatFinding(file: string, f: Finding, width: number): string {
  const detail = f.detail ? ` (${f.detail})` : '';
  const shown = f.match.length > 60 ? `${f.match.slice(0, 57)}...` : f.match;
  return `${location(file, f).padEnd(width)}  L${f.level} ${f.severity.padEnd(10)} ${f.ruleId.padEnd(9)} ${f.message}${detail}\n    "${shown.replace(/\n/gu, ' ')}" -> ${f.suggestion}`;
}

function summary(result: LintResult): string {
  const counts = [1, 2, 3].map((level) => `L${level} ${result.findings.filter((f) => f.level === level).length}`).join(', ');
  const verdict = result.disqualified ? 'disqualified' : result.passesTier1 ? 'passes tier 1' : 'fails tier 1';
  return `${result.findings.length} findings (${counts}); slop score ${result.score.points}/${result.score.max}; ${verdict}`;
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  if (typeof args === 'string') {
    process.stderr.write(`${args}\n${USAGE}\n`);
    return 2;
  }
  const runs: Array<{ file: string; format: Format; result: LintResult }> = [];
  for (const file of args.files) {
    let text: string;
    try {
      text = readFileSync(file === '-' ? 0 : file, 'utf8');
    } catch (error) {
      process.stderr.write(`cannot read ${file}: ${(error as Error).message}\n`);
      return 2;
    }
    const format = formatFor(file, args.format);
    const options: LintOptions = { lang: args.lang, anchors: args.anchors, format };
    runs.push({ file, format, result: lint(text, options) });
  }
  const code = runs.every((r) => r.result.passesTier1) ? 0 : 1;
  const single = runs.length === 1 ? runs[0] : undefined;
  let out: string;
  if (args.json) {
    out = `${JSON.stringify(single ? single.result : runs, null, 2)}\n`;
  } else {
    out = runs
      .map(({ file, result }) => {
        const width = Math.max(0, ...result.findings.map((f) => location(file, f).length));
        const prefix = single ? '' : `${file}: `;
        return result.findings.map((f) => `${formatFinding(file, f, width)}\n`).join('') + `${prefix}${summary(result)}\n`;
      })
      .join('');
  }
  // A closed pipe (`| head`) is not an error of the lint; keep the lint's exit code.
  process.stdout.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') process.exit(code);
    throw error;
  });
  process.stdout.write(out);
  return code;
}

process.exitCode = main();
