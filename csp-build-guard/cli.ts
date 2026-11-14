#!/usr/bin/env node
// Usage: node csp-build-guard/cli.ts --dir <build folder> [--config csp-guard.config.json] [--json | --sarif [--sarif-base <dir>]]
// Audits a built static site, or a Vercel Build Output folder, before deploy. See README.md.
// Without --config it looks for csp-guard.config.json, then csp-guard.config.ts, in the current folder.
// --sarif prints SARIF 2.1.0 instead of the text report, with paths relative to --sarif-base
// (default: the current folder). --json and --sarif are mutually exclusive.
// Exit codes: 0 every check passed or was skipped, 1 a check failed, 2 bad usage, config or input.
// They are the same with --json and --sarif; on exit 2 nothing is printed to stdout.
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { ConfigError, loadConfig } from './src/config.ts';
import { formatReport } from './src/report.ts';
import { runGuard } from './src/run.ts';
import { toSarif } from './src/sarif.ts';
import { InputError } from './src/site.ts';

const USAGE =
  'usage: node csp-build-guard/cli.ts --dir <build folder> [--config <csp-guard.config.json|.ts>] [--json | --sarif [--sarif-base <dir>]]';

async function main(): Promise<number> {
  let values: { dir?: string; config?: string; json?: boolean; sarif?: boolean; 'sarif-base'?: string; help?: boolean };
  try {
    ({ values } = parseArgs({
      options: {
        dir: { type: 'string' },
        config: { type: 'string' },
        json: { type: 'boolean' },
        sarif: { type: 'boolean' },
        'sarif-base': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n${USAGE}\n`);
    return 2;
  }
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (values.json && values.sarif) {
    process.stderr.write(`--json and --sarif are mutually exclusive\n${USAGE}\n`);
    return 2;
  }
  if (values['sarif-base'] !== undefined && !values.sarif) {
    process.stderr.write(`--sarif-base needs --sarif\n${USAGE}\n`);
    return 2;
  }
  if (values.dir === undefined) {
    process.stderr.write(`missing --dir\n${USAGE}\n`);
    return 2;
  }
  const configPath = values.config ?? ['csp-guard.config.json', 'csp-guard.config.ts'].find((p) => existsSync(p));
  if (configPath === undefined) {
    process.stderr.write(`no --config and no csp-guard.config.json or csp-guard.config.ts here\n${USAGE}\n`);
    return 2;
  }
  try {
    const config = await loadConfig(configPath);
    const report = runGuard({ dir: values.dir, config });
    let output: string;
    if (values.sarif) {
      const base = values['sarif-base'];
      output = `${JSON.stringify(toSarif(report, { configPath, ...(base === undefined ? {} : { base }) }), null, 2)}\n`;
    } else output = values.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report, values.dir);
    process.stdout.write(output);
    return report.ok ? 0 : 1;
  } catch (error) {
    const known = error instanceof ConfigError || error instanceof InputError;
    process.stderr.write(`${known ? '' : 'error: '}${(error as Error).message}\n`);
    return 2;
  }
}

process.exitCode = await main();
