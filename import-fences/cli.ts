#!/usr/bin/env node
// Usage: node import-fences/cli.ts [--config import-fences.config.ts|.json] [--json | --sarif [--sarif-base <dir>]]
// Checks the architecture rules of a config over a repository. See README.md.
// Without --config it loads import-fences.config.ts from the current folder, or
// import-fences.config.json when there is no .ts one.
// --sarif prints SARIF 2.1.0 instead of the text report, with paths relative to --sarif-base
// (default: the current folder). --json and --sarif are mutually exclusive.
// Exit codes: 0 no violation, 1 at least one violation, 2 bad usage or an invalid config.
// They are the same with --json and --sarif; on exit 2 nothing is printed to stdout.
import { existsSync } from 'node:fs';
import { relative } from 'node:path';
import { parseArgs } from 'node:util';
import { check } from './src/check.ts';
import { ConfigError, loadConfig } from './src/config.ts';
import { diskSource } from './src/files.ts';
import { formatText } from './src/report.ts';
import { toSarif } from './src/sarif.ts';

const USAGE = 'usage: node import-fences/cli.ts [--config <import-fences.config.ts|.json>] [--json | --sarif [--sarif-base <dir>]]';
const DEFAULT_CONFIGS = ['import-fences.config.ts', 'import-fences.config.json'] as const;

async function main(): Promise<number> {
  let values: { config?: string; json?: boolean; sarif?: boolean; 'sarif-base'?: string; help?: boolean };
  try {
    ({ values } = parseArgs({
      options: {
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
  if (values.help === true) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (values.json === true && values.sarif === true) {
    process.stderr.write(`--json and --sarif are mutually exclusive\n${USAGE}\n`);
    return 2;
  }
  if (values['sarif-base'] !== undefined && values.sarif !== true) {
    process.stderr.write(`--sarif-base needs --sarif\n${USAGE}\n`);
    return 2;
  }
  const configPath = values.config ?? DEFAULT_CONFIGS.find((p) => existsSync(p)) ?? DEFAULT_CONFIGS[0];
  try {
    const { config, root } = await loadConfig(configPath);
    const result = check(config, diskSource(root, config.ignore), relative(root, configPath) || configPath);
    let output: string;
    if (values.sarif === true) {
      const base = values['sarif-base'];
      output = `${JSON.stringify(toSarif(result, { root, configPath, ...(base === undefined ? {} : { base }) }), null, 2)}\n`;
    } else output = values.json === true ? `${JSON.stringify(result, null, 2)}\n` : formatText(result);
    process.stdout.write(output);
    return result.violations.length === 0 ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error instanceof ConfigError ? '' : 'error: '}${(error as Error).message}\n`);
    return 2;
  }
}

process.exitCode = await main();
