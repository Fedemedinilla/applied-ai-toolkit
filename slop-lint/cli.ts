#!/usr/bin/env node
// Usage: node slop-lint/cli.ts <file|-> [file...] --lang en|es [--format text|markdown] [--json | --sarif [--sarif-uri uri]] [--anchors "dbt,pandas,Contoso Agro"] [--config file | --no-config]
//        node slop-lint/cli.ts --list-rules [--json] [file] [--config file | --no-config]
// A file ending in .md is read as Markdown unless --format says otherwise; anything else, stdin included, as text.
// With several files, each one's findings are followed by its own summary line, prefixed with its name.
// --sarif prints one SARIF 2.1.0 log for every file instead; --sarif-uri names stdin in it ("stdin" by default).
// slop-lint.config.json is looked for from the working directory upward, up to the repository root; --config names
// one, --no-config ignores it. A flag given here wins over the config file, which may also supply --lang.
// --list-rules prints every rule that applies, after the config file; with one file, as that file's overrides leave them.
// Exit codes: 0 no level 1 finding, 1 at least one level 1 finding in any file, 2 bad usage, a bad config file or unreadable input.
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { isCustomId, isIgnored, settingsFor, type Config, type Settings } from './src/config.ts';
import { configPath, findConfig, loadConfig, type LoadedConfig } from './src/config-file.ts';
import { lint } from './src/lint.ts';
import { RULES } from './src/rules.ts';
import { artifactUri, toSarif } from './src/sarif.ts';
import type { Finding, Format, Lang, LintOptions, LintResult, Rule } from './src/types.ts';

const USAGE =
  'usage: node slop-lint/cli.ts <file|-> [file...] --lang en|es [--format text|markdown] [--json | --sarif [--sarif-uri uri]] [--anchors a,b,c] [--config file | --no-config]\n' +
  '       node slop-lint/cli.ts --list-rules [--json] [file] [--config file | --no-config]';

interface Args {
  files: string[];
  lang: Lang | undefined;
  format: Format | undefined;
  json: boolean;
  sarif: boolean;
  /** The uri stdin gets in the SARIF log. */
  sarifUri: string | undefined;
  /** Undefined when --anchors was not given, so the config file's anchors apply. */
  anchors: string[] | undefined;
  config: string | undefined;
  noConfig: boolean;
  listRules: boolean;
}

function parseArgs(argv: readonly string[]): Args | string {
  const files: string[] = [];
  let lang: string | undefined;
  let format: string | undefined;
  let json = false;
  let sarif = false;
  let sarifUri: string | undefined;
  let anchors: string[] | undefined;
  let config: string | undefined;
  let noConfig = false;
  let listRules = false;
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
    else if (arg === '--config') config = argv[++i] ?? '';
    else if (arg.startsWith('--config=')) config = arg.slice('--config='.length);
    else if (arg === '--no-config') noConfig = true;
    else if (arg === '--list-rules') listRules = true;
    else if (arg === '-' || !arg.startsWith('-')) files.push(arg);
    else return `unknown option ${arg}`;
  }
  if (config === '') return '--config needs a file';
  if (config !== undefined && noConfig) return '--config and --no-config cannot be used together';
  if (listRules) {
    if (sarif) return '--list-rules prints text or --json, not --sarif';
    if (files.length > 1) return '--list-rules takes at most one file';
  } else {
    if (files.length === 0) return 'missing input file';
    if (files.filter((f) => f === '-').length > 1) return 'stdin can be read only once';
  }
  // A missing --lang is judged later, file by file: the config file may supply it.
  if (lang !== undefined && lang !== 'en' && lang !== 'es') return '--lang must be en or es';
  if (format !== undefined && format !== 'text' && format !== 'markdown') return '--format must be text or markdown';
  if (json && sarif) return '--json and --sarif cannot be used together';
  if (sarifUri !== undefined && !sarif) return '--sarif-uri needs --sarif';
  if (sarifUri !== undefined && !files.includes('-')) return '--sarif-uri names stdin, and no input is -';
  if (sarifUri === '') return '--sarif-uri needs a value';
  return { files, lang, format, json, sarif, sarifUri, anchors: anchors?.map((a) => a.trim()).filter(Boolean), config, noConfig, listRules };
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
  // The two tails only appear with inline directives, so a document without them prints the line it always did.
  const suppressed = result.suppressed ? `; ${result.suppressed.length} suppressed` : '';
  const n = result.directiveProblems?.length ?? 0;
  const problems = n > 0 ? `; ${n} directive problem${n === 1 ? '' : 's'}` : '';
  return `${result.findings.length} findings (${counts}); slop score ${result.score.points}/${result.score.max}; ${verdict}${suppressed}${problems}`;
}

const pad = (value: string | number, width: number): string => String(value).padEnd(width);

/** --list-rules: every rule that applies, with where it comes from and what the config changed. */
function listRules(settings: Settings, configFile: string | null, json: boolean): string {
  const defaults = new Map(RULES.map((r) => [r.id, r]));
  const rows = settings.rules.map((r: Rule) => {
    const original = defaults.get(r.id);
    const changed = original !== undefined && (original.level !== r.level || original.severity !== r.severity);
    return {
      id: r.id,
      name: r.name,
      lang: r.lang,
      level: r.level,
      severity: r.severity,
      kind: r.kind,
      source: isCustomId(r.id) ? ('config' as const) : ('built-in' as const),
      ...(changed ? { default: { level: original.level, severity: original.severity } } : {}),
    };
  });
  if (json) return `${JSON.stringify({ config: configFile, rules: rows, off: settings.off }, null, 2)}\n`;
  const idWidth = Math.max(2, ...rows.map((r) => r.id.length));
  const lines = [`${pad('id', idWidth)}  level  severity    lang  kind        source    name`];
  for (const r of rows) {
    const was = r.default ? ` (default: level ${r.default.level}, ${r.default.severity})` : '';
    lines.push(`${pad(r.id, idWidth)}  ${pad(r.level, 5)}  ${pad(r.severity, 10)}  ${pad(r.lang, 4)}  ${pad(r.kind, 10)}  ${pad(r.source, 8)}  ${r.name}${was}`);
  }
  const custom = rows.filter((r) => r.source === 'config').length;
  lines.push(`${rows.length} rules: ${rows.length - custom} built-in, ${custom} from the config; ${settings.off.length} off${settings.off.length > 0 ? ` (${settings.off.join(', ')})` : ''}`);
  lines.push(configFile === null ? 'no config file' : `config: ${configFile}`);
  return `${lines.join('\n')}\n`;
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  if (typeof args === 'string') {
    process.stderr.write(`${args}\n${USAGE}\n`);
    return 2;
  }
  const cwd = process.cwd();
  let loaded: LoadedConfig | undefined;
  if (!args.noConfig) {
    const found = args.config === undefined ? findConfig(cwd) : undefined;
    // A discovered file is named relative to the working directory, as a --config path is typed.
    const path = args.config ?? (found === undefined ? undefined : relative(cwd, found) || found);
    if (path !== undefined) {
      try {
        loaded = loadConfig(path);
      } catch (error) {
        process.stderr.write(`${(error as Error).message}\n`);
        return 2;
      }
    }
  }
  const config: Config = loaded?.config ?? {};
  const shownConfig = loaded === undefined ? null : relative(cwd, loaded.path) || loaded.path;
  const pathOf = (file: string): string | undefined => (loaded === undefined || file === '-' ? undefined : configPath(loaded.dir, file, cwd));

  if (args.listRules) {
    const [file] = args.files;
    process.stdout.write(listRules(settingsFor(config, file === undefined ? undefined : pathOf(file)), shownConfig, args.json));
    return 0;
  }

  const files = args.files.filter((file) => !isIgnored(config, pathOf(file)));
  // The language of every file is settled before any is read: a file without one is a usage error.
  const plans = new Map<string, { settings: Settings; lang: Lang }>();
  for (const file of files) {
    const settings = settingsFor(config, pathOf(file));
    const lang = args.lang ?? settings.lang;
    if (lang === undefined) {
      const hint = loaded === undefined ? '' : `; ${shownConfig ?? ''} sets no lang for ${file}`;
      process.stderr.write(`--lang must be en or es${hint}\n${USAGE}\n`);
      return 2;
    }
    plans.set(file, { settings, lang });
  }
  // The uris are worked out before any file is read: a path SARIF cannot name is a usage error.
  const uris = new Map<string, string>();
  if (args.sarif) {
    for (const file of files) {
      try {
        uris.set(file, artifactUri(file === '-' ? (args.sarifUri ?? 'stdin') : file, cwd));
      } catch (error) {
        process.stderr.write(`${(error as Error).message}\n${USAGE}\n`);
        return 2;
      }
    }
  }
  const runs: Array<{ file: string; format: Format; text: string; result: LintResult; rules: readonly Rule[] | undefined }> = [];
  let failOnProblems = false;
  for (const file of files) {
    let text: string;
    try {
      // A leading byte order mark is not text: editors do not show it, so it is no column either.
      text = readFileSync(file === '-' ? 0 : file, 'utf8').replace(/^﻿/u, '');
    } catch (error) {
      process.stderr.write(`cannot read ${file}: ${(error as Error).message}\n`);
      return 2;
    }
    const plan = plans.get(file);
    if (!plan) continue;
    const { settings, lang } = plan;
    const format = formatFor(file, args.format ?? settings.format);
    const options: LintOptions = { lang, anchors: args.anchors ?? settings.anchors, format };
    // Without a config file lint() gets exactly the options it always got.
    if (loaded !== undefined) {
      options.rules = settings.rules;
      options.suppressions = { allowDisqualify: settings.suppressions.allowDisqualify, mask: settings.suppressions.mask };
      failOnProblems = failOnProblems || settings.suppressions.failOnProblems;
    }
    runs.push({ file, format, text, result: lint(text, options), rules: options.rules });
  }
  if (files.length < args.files.length && files.length === 0) {
    process.stderr.write(`slop-lint: every input file is ignored by ${shownConfig ?? 'the config file'}\n`);
  }
  const passes = (r: LintResult): boolean => r.passesTier1 && !(failOnProblems && (r.directiveProblems?.length ?? 0) > 0);
  const code = runs.every((r) => passes(r.result)) ? 0 : 1;
  const single = args.files.length === 1 && runs.length === 1 ? runs[0] : undefined;
  let out: string;
  if (args.sarif) {
    const inputs = runs.map(({ file, text, result, rules }) => ({ uri: uris.get(file) ?? '', text, result, ...(rules === undefined ? {} : { rules }) }));
    out = `${JSON.stringify(toSarif(inputs), null, 2)}\n`;
  } else if (args.json) {
    // The text is kept for SARIF regions only; the JSON report never held the files' contents.
    out = `${JSON.stringify(single ? single.result : runs.map(({ file, format, result }) => ({ file, format, result })), null, 2)}\n`;
  } else {
    out = runs
      .map(({ file, result }) => {
        const rows = [...result.findings, ...(result.directiveProblems ?? [])];
        const width = Math.max(0, ...rows.map((f) => location(file, f).length));
        const prefix = single ? '' : `${file}: `;
        return rows.map((f) => `${formatFinding(file, f, width)}\n`).join('') + `${prefix}${summary(result)}\n`;
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
