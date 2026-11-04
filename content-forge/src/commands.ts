/**
 * The command line, as a function: argv in, lines out, an exit code back. cli.ts reads the
 * environment and calls it; the tests call it with a fake Anthropic API.
 *
 *   validate                                  check the whole catalogue
 *   generate --entity E --count N [--brief T] ask the model, judge, write candidates and a report
 *   promote --entity E (--all | ID...) [--replace]
 *   stats                                     pass rate per entity type and prompt version
 *
 * Every command takes --dir (default: the example catalogue next to this folder).
 *
 * Exit codes: 0 done; 1 the catalogue or a promote has problems, a run accepted nothing or could
 * not write a candidate, or an unexpected error;
 * 2 bad usage; 3 the model could not be reached or refused the call (no key, a cap, the network).
 */
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { checkCatalog, formatProblem } from './catalog.ts';
import { ForgeError } from './errors.ts';
import { loadCatalog } from './files.ts';
import { generate } from './generate.ts';
import { createForgeModel, GatewayError, type ModelOptions } from './model.ts';
import { MAX_COUNT } from './prompt.ts';
import { promote } from './promote.ts';
import { formatRun, formatStats, loadReports, summarize } from './report.ts';
import { ENTITY_NAMES, isEntityName } from './schemas.ts';

export const DEFAULT_DIR = fileURLToPath(new URL('../catalog/', import.meta.url));

export interface CliIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  /** Null without a key: generate then exits 3 before any call. */
  readonly apiKey: string | null;
  /** For tests: a fake Anthropic HTTP API. */
  readonly fetch?: ModelOptions['fetch'];
  readonly now?: () => Date;
  readonly log?: (line: string) => void;
}

export const USAGE = `usage:
  node content-forge/cli.ts validate [--dir DIR]
  node content-forge/cli.ts generate --entity ${ENTITY_NAMES.join('|')} --count 1-${MAX_COUNT} [--brief TEXT] [--dir DIR]
  node content-forge/cli.ts promote --entity NAME (--all | ID...) [--replace] [--dir DIR]
  node content-forge/cli.ts stats [--dir DIR]`;

export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        dir: { type: 'string' },
        entity: { type: 'string' },
        count: { type: 'string' },
        brief: { type: 'string' },
        all: { type: 'boolean' },
        replace: { type: 'boolean' },
      },
    });
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    io.err(USAGE);
    return 2;
  }
  const [command, ...rest] = parsed.positionals;
  const { values } = parsed;
  const dir = values.dir ?? DEFAULT_DIR;
  const usage = (message: string): number => {
    io.err(message);
    io.err(USAGE);
    return 2;
  };
  const entity = (): string | null => values.entity ?? null;

  try {
    switch (command) {
      case 'validate': {
        if (rest.length > 0) return usage('validate takes no arguments');
        const loaded = await loadCatalog(dir);
        const checked = checkCatalog(loaded.raw);
        const problems = [...loaded.problems, ...(checked.ok ? [] : checked.problems)];
        if (problems.length > 0 || !checked.ok) {
          for (const p of problems) io.err(formatProblem(p));
          io.err(`${problems.length} problem(s)`);
          return 1;
        }
        const counts = ENTITY_NAMES.map((e) => `${checked.index[e].size} ${e}`).join(', ');
        io.out(`catalogue valid: ${counts}`);
        return 0;
      }
      case 'generate': {
        const name = entity();
        if (name === null || !isEntityName(name)) return usage(`--entity must be one of ${ENTITY_NAMES.join(', ')}`);
        if (rest.length > 0) return usage('generate takes no positional arguments');
        const count = Number(values.count ?? '');
        if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) return usage(`--count must be a whole number from 1 to ${MAX_COUNT}`);
        if (io.apiKey === null) {
          io.err('generate needs ANTHROPIC_API_KEY. validate, promote and stats run without it.');
          return 3;
        }
        const model = createForgeModel({
          apiKey: io.apiKey,
          ...(io.fetch ? { fetch: io.fetch } : {}),
          ...(io.log ? { log: io.log } : {}),
        });
        const report = await generate({ dir, entity: name, count, brief: values.brief ?? null }, { gateway: model.gateway, now: io.now ?? (() => new Date()) });
        for (const line of formatRun(report)) io.out(line);
        return report.accepted.length > 0 && report.unwritten.length === 0 ? 0 : 1;
      }
      case 'promote': {
        const name = entity();
        if (name === null || !isEntityName(name)) return usage(`--entity must be one of ${ENTITY_NAMES.join(', ')}`);
        if ((values.all ?? false) === rest.length > 0) return usage('promote takes --all or a list of ids, not both');
        const result = await promote({ dir, entity: name, ids: values.all ? 'all' : rest, replace: values.replace ?? false });
        for (const id of result.moved) io.out(`promoted ${name} ${id}${result.replaced.includes(id) ? ' (replaced the generated entry)' : ''}`);
        return 0;
      }
      case 'stats': {
        if (rest.length > 0) return usage('stats takes no arguments');
        const { reports, invalid } = await loadReports(dir);
        for (const line of formatStats(summarize(reports))) io.out(line);
        for (const file of invalid) io.err(`not a valid report, not counted: ${file}`);
        return 0;
      }
      default:
        return usage(command === undefined ? 'no command' : `unknown command "${command}"`);
    }
  } catch (error) {
    if (error instanceof ForgeError) {
      io.err(error.message);
      return error.code === 'bad_request' ? 2 : 1;
    }
    if (error instanceof GatewayError) {
      // A code, never the model's text or the API's message, which can echo the prompt.
      io.err(`the model call failed: ${error.code}`);
      return 3;
    }
    // Anything else (a file system error, a bug) gets one line: the error code, never a stack trace
    // or a message, which would carry local paths.
    const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : error instanceof Error ? error.name : 'unknown';
    io.err(`${command ?? 'the command'} failed: ${code}`);
    return 1;
  }
}
