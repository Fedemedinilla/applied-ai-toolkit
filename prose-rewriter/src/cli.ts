/**
 * The testable core of prose-rewriter/cli.ts (design 4.11): argument parsing, reading the files,
 * the input, the call to rewrite() and the output. Everything with a side effect comes in through
 * CliDeps, so the tests run it over the scripted gateway; only cli.ts builds the live gateway.
 *
 * - The API key comes from ANTHROPIC_API_KEY in the environment, which cli.ts reads and passes in,
 *   never from a file or an argument. Without it the CLI refuses to run, unless S1b returns before
 *   any model call.
 * - The CV path is read and never written to stdout or stderr: a CV that cannot be read is
 *   reported without its path, and the output never names it.
 * - A failed model call prints the error's name, and for a gateway error its code and message,
 *   never its cause (README, "What the gateway records").
 *
 * Exit codes (design 4.11 left them "a confirmar"; PROVISIONAL): 0 ok, 1 needs-review, 2 blocked,
 * 3 bad usage (arguments, an unreadable file, an input the schema refuses), 4 could not run (no
 * API key, or a model call failed).
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { GatewayError, type Gateway } from '../../gateway/src/index.ts';
import { Example, LANGS, Principle, Source } from '../../style-refs/src/index.ts';
import type { PromptRefs } from './prompt.ts';
import { rewrite } from './rewrite.ts';
import { analyse, earlyExit, prepare } from './stages/analyse.ts';
import { Genre, Lang, Mode, RewriteInput, type RewriteResult, Variety } from './types.ts';

export const EXIT = { ok: 0, needsReview: 1, blocked: 2, usage: 3, failed: 4 } as const;

export const USAGE =
  'usage: node prose-rewriter/cli.ts --genre cover-letter|email|follow-up|whatsapp --lang es|en [--variety rioplatense|neutral] ' +
  '--cv <file> [--to recipient.json] [--previous file] [--mode minimo|pulido|reescritura] [--keep "phrase"]... [--strict] [--json] <draft file>';

export interface Args {
  readonly genre: Genre;
  readonly lang: Lang;
  readonly variety?: Variety;
  readonly cv: string;
  readonly to?: string;
  readonly previous?: string;
  readonly mode?: Mode;
  readonly keep: string[];
  readonly strict: boolean;
  readonly json: boolean;
  readonly draft: string;
}

const VALUE_FLAGS = ['genre', 'lang', 'variety', 'cv', 'to', 'previous', 'mode', 'keep'] as const;
type ValueFlag = (typeof VALUE_FLAGS)[number];

/**
 * The arguments, or a message saying what is wrong. `--help` is handled by runCli. `--` ends the
 * options; a value option given twice is refused (only --keep repeats).
 */
export function parseArgs(argv: readonly string[]): Args | string {
  const values: Partial<Record<Exclude<ValueFlag, 'keep'>, string>> = {};
  const keep: string[] = [];
  const positionals: string[] = [];
  let strict = false;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg === '--strict') strict = true;
    else if (arg === '--json') json = true;
    else if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = arg.slice(2, eq === -1 ? undefined : eq);
      if (name === 'strict' || name === 'json') return `--${name} takes no value`;
      if (!(VALUE_FLAGS as readonly string[]).includes(name)) return `unknown option --${name}`;
      const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
      if (value === undefined || value === '') return `--${name} needs a value`;
      if (name === 'keep') keep.push(value);
      else if (values[name as Exclude<ValueFlag, 'keep'>] !== undefined) return `--${name} is given twice`;
      else values[name as Exclude<ValueFlag, 'keep'>] = value;
    } else positionals.push(arg);
  }
  const genre = Genre.safeParse(values.genre);
  if (!genre.success) return values.genre === undefined ? '--genre is required' : `--genre must be one of ${Genre.options.join(', ')}`;
  const lang = Lang.safeParse(values.lang);
  if (!lang.success) return values.lang === undefined ? '--lang is required' : '--lang must be es or en';
  const variety = Variety.optional().safeParse(values.variety);
  if (!variety.success) return '--variety must be rioplatense or neutral';
  const mode = Mode.optional().safeParse(values.mode);
  if (!mode.success) return '--mode must be minimo, pulido or reescritura';
  if (values.cv === undefined) return '--cv is required';
  if (positionals.length === 0) return 'the draft file is missing';
  if (positionals.length > 1) return 'give exactly one draft file';
  return {
    genre: genre.data,
    lang: lang.data,
    ...(variety.data === undefined ? {} : { variety: variety.data }),
    cv: values.cv,
    ...(values.to === undefined ? {} : { to: values.to }),
    ...(values.previous === undefined ? {} : { previous: values.previous }),
    ...(mode.data === undefined ? {} : { mode: mode.data }),
    keep,
    strict,
    json,
    draft: positionals[0] ?? '',
  };
}

export interface CliDeps {
  /** ANTHROPIC_API_KEY as cli.ts read it from the environment, the one place allowed to (import-fences/repo.config.ts). */
  readonly apiKey: string | undefined;
  readonly readFile: (path: string) => string;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** Builds the gateway from the key. cli.ts passes the live one; the tests a scripted one. */
  readonly gateway: (apiKey: string) => Gateway<string>;
  /** style-refs' data, loaded only when a model call is coming. */
  readonly refs: () => PromptRefs;
}

/** style-refs' sources, principles and examples, each checked with its schema. `root` is the repository root. */
export function loadRefs(root: URL, readFile: (path: string) => string = (path) => readFileSync(path, 'utf8')): PromptRefs {
  const json = (file: string): unknown[] => z.array(z.unknown()).parse(JSON.parse(readFile(fileURLToPath(new URL(file, root)))));
  return {
    sources: json('style-refs/sources.json').map((s) => Source.parse(s)),
    principles: LANGS.flatMap((lang) => json(`style-refs/principles/${lang}.json`).map((p) => Principle.parse(p))),
    examples: LANGS.flatMap((lang) => json(`style-refs/examples/${lang}.json`).map((e) => Example.parse(e))),
  };
}

class UsageError extends Error {}

const Recipient = z.record(z.string(), z.unknown());

function buildInput(args: Args, deps: CliDeps): RewriteInput {
  const read = (path: string, what: string): string => {
    try {
      return deps.readFile(path);
    } catch {
      throw new UsageError(`could not read ${what}`);
    }
  };
  const text = read(args.draft, `the draft file ${args.draft}`);
  // Never the CV's path: it may name the user or their folders.
  const cvMarkdown = read(args.cv, 'the CV file');
  let recipient: Record<string, unknown> | undefined;
  if (args.to !== undefined) {
    const raw = read(args.to, `the recipient file ${args.to}`);
    try {
      recipient = Recipient.parse(JSON.parse(raw));
    } catch {
      throw new UsageError(`the recipient file ${args.to} is not a JSON object`);
    }
  }
  if (args.previous !== undefined) recipient = { ...recipient, previousMessage: read(args.previous, `the previous message file ${args.previous}`) };
  const input = RewriteInput.safeParse({
    text,
    genre: args.genre,
    lang: args.lang,
    ...(args.variety === undefined ? {} : { variety: args.variety }),
    ...(args.mode === undefined ? {} : { mode: args.mode }),
    profile: { cvMarkdown },
    ...(recipient === undefined ? {} : { recipient }),
    ...(args.keep.length === 0 ? {} : { keep: args.keep }),
    ...(args.strict ? { strict: true } : {}),
  });
  if (!input.success) {
    // Paths and zod's own messages only: neither quotes the text or the CV.
    throw new UsageError(`invalid input: ${input.error.issues.map((i) => `${i.path.join('.') || '(input)'}: ${i.message}`).join('; ')}`);
  }
  return input.data;
}

const quote = (s: string): string => JSON.stringify(s);

/** The human-readable report: the text first, then the changes, the facts, the flags and the status. */
export function formatResult(result: RewriteResult): string {
  const lines: string[] = [result.rewritten, ''];
  if (result.message !== undefined) lines.push(result.message, '');
  lines.push(`Changes (${result.changes.length}):`);
  for (const c of result.changes) {
    const tag = [c.stage, c.ruleId, c.principleId].filter((x) => x !== undefined).join(', ');
    lines.push(`  [${c.status}] ${c.id} (${tag}): ${quote(c.before)} -> ${quote(c.after)}`);
    lines.push(`      ${c.reason}${c.revertReason === undefined ? '' : ` | reverted: ${c.revertReason}`}`);
  }
  const list = (xs: readonly string[]): string => (xs.length === 0 ? '-' : xs.join('; '));
  lines.push('Facts:', `  from the CV: ${list(result.facts.fromCv)}`, `  not in the CV: ${list(result.facts.notInCv)}`, `  placeholders: ${list(result.facts.placeholders)}`);
  lines.push(`Flags (${result.flags.length}):`);
  for (const f of result.flags) lines.push(`  [${f.kind}] ${f.message}`);
  const cost = result.usage.costUsd === null ? 'cost unknown' : `US$${result.usage.costUsd.toFixed(4)}`;
  lines.push(`Status: ${result.status} (${result.usage.calls} model calls, ${cost})`);
  return `${lines.join('\n')}\n`;
}

const STATUS_EXIT: Readonly<Record<RewriteResult['status'], number>> = { ok: EXIT.ok, 'needs-review': EXIT.needsReview, blocked: EXIT.blocked };

function failure(error: unknown): string {
  // Never error.cause: an ApiError keeps the SDK's error, with the API's own message, as its cause.
  if (error instanceof GatewayError) return `${error.name} (${error.code}): ${error.message}`;
  return error instanceof Error ? error.name : 'unknown error';
}

/** Whether --help or -h stands as an option of its own: not as the value of an option, nor after --. */
function wantsHelp(argv: readonly string[]): boolean {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '--') return false;
    if (arg === '--help' || arg === '-h') return true;
    if (arg.startsWith('--') && !arg.includes('=') && (VALUE_FLAGS as readonly string[]).includes(arg.slice(2))) i++;
  }
  return false;
}

export async function runCli(argv: readonly string[], deps: CliDeps): Promise<number> {
  if (wantsHelp(argv)) {
    deps.stdout(`${USAGE}\n`);
    return EXIT.ok;
  }
  const args = parseArgs(argv);
  if (typeof args === 'string') {
    deps.stderr(`${args}\n${USAGE}\n`);
    return EXIT.usage;
  }
  let input: RewriteInput;
  try {
    input = buildInput(args, deps);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    deps.stderr(`${error.message}\n`);
    return EXIT.usage;
  }
  const print = (result: RewriteResult): number => {
    deps.stdout(args.json ? `${JSON.stringify(result, null, 2)}\n` : formatResult(result));
    return STATUS_EXIT[result.status];
  };

  // S1b needs no model, so a text with nothing to change needs no key either.
  const early = earlyExit(analyse(prepare(input)));
  if (early !== null) return print(early);

  const key = deps.apiKey?.trim() ?? '';
  if (key === '') {
    deps.stderr('prose-rewriter needs ANTHROPIC_API_KEY in the environment to call the model; it never reads the key from a file or an argument.\n');
    return EXIT.failed;
  }
  try {
    // One jobId per run, so the per-job cap covers the calls of this rewrite.
    return print(await rewrite(input, { gateway: deps.gateway(key), refs: deps.refs(), jobId: randomUUID() }));
  } catch (error) {
    deps.stderr(`rewrite failed: ${failure(error)}\n`);
    return EXIT.failed;
  }
}
