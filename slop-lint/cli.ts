#!/usr/bin/env node
// Usage: node slop-lint/cli.ts <file|-> [file...] --lang en|es [--format text|markdown] [--json | --sarif [--sarif-uri uri]] [--anchors "dbt,pandas,Contoso Agro"]
// A file ending in .md is read as Markdown unless --format says otherwise; anything else, stdin included, as text.
// With several files, each one's findings are followed by its own summary line, prefixed with its name.
// --sarif prints one SARIF 2.1.0 log for every file instead; --sarif-uri names stdin in it ("stdin" by default).
// Exit codes: 0 no level 1 finding, 1 at least one level 1 finding in any file, 2 bad usage or unreadable input.
import { readFileSync } from 'node:fs';
import { lint } from './src/lint.ts';
import { artifactUri, toSarif } from './src/sarif.ts';
import type { Finding, Format, Lang, LintOptions, LintResult } from './src/types.ts';

const USAGE =
  'usage: node slop-lint/cli.ts <file|-> [file...] --lang en|es [--format text|markdown] [--json | --sarif [--sarif-uri uri]] [--anchors a,b,c]';

interface Args {
  files: string[];
  lang: Lang;
  format: Format | undefined;
  json: boolean;
  sarif: boolean;
  /** The uri stdin gets in the SARIF log. */
  sarifUri: string | undefined;
  anchors: string[];
}

function parseArgs(argv: readonly string[]): Args | string {
  const files: string[] = [];
  let lang: string | undefined;
  let format: string | undefined;
  let json = false;
  let sarif = false;
  let sarifUri: string | undefined;
  let anchors: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '--json') json = true;
    else if (arg === '--sarif') sarif = true;
    else if (arg === '--sarif-uri') sarifUri = argv[++i] ?? '';
    else if (arg.startsWith('--sarif-uri=')) sarifUri = arg.slice('--sarif-uri='.length);
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
  if (json && sarif) return '--json and --sarif cannot be used together';
  if (sarifUri !== undefined && !sarif) return '--sarif-uri needs --sarif';
  if (sarifUri !== undefined && !files.includes('-')) return '--sarif-uri names stdin, and no input is -';
  if (sarifUri === '') return '--sarif-uri needs a value';
  return { files, lang, format, json, sarif, sarifUri, anchors: anchors.map((a) => a.trim()).filter(Boolean) };
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
  // The uris are worked out before any file is read: a path SARIF cannot name is a usage error.
  const uris = new Map<string, string>();
  if (args.sarif) {
    for (const file of args.files) {
      try {
        uris.set(file, artifactUri(file === '-' ? (args.sarifUri ?? 'stdin') : file, process.cwd()));
      } catch (error) {
        process.stderr.write(`${(error as Error).message}\n${USAGE}\n`);
        return 2;
      }
    }
  }
  const runs: Array<{ file: string; format: Format; text: string; result: LintResult }> = [];
  for (const file of args.files) {
    let text: string;
    try {
      // A leading byte order mark is not text: editors do not show it, so it is no column either.
      text = readFileSync(file === '-' ? 0 : file, 'utf8').replace(/^\uFEFF/u, '');
    } catch (error) {
      process.stderr.write(`cannot read ${file}: ${(error as Error).message}\n`);
      return 2;
    }
    const format = formatFor(file, args.format);
    const options: LintOptions = { lang: args.lang, anchors: args.anchors, format };
    runs.push({ file, format, text, result: lint(text, options) });
  }
  const code = runs.every((r) => r.result.passesTier1) ? 0 : 1;
  const single = runs.length === 1 ? runs[0] : undefined;
  let out: string;
  if (args.sarif) {
    out = `${JSON.stringify(toSarif(runs.map(({ file, text, result }) => ({ uri: uris.get(file) ?? '', text, result }))), null, 2)}\n`;
  } else if (args.json) {
    // The text is kept for SARIF regions only; the JSON report never held the files' contents.
    out = `${JSON.stringify(single ? single.result : runs.map(({ file, format, result }) => ({ file, format, result })), null, 2)}\n`;
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
