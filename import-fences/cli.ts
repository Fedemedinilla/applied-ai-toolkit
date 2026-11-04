#!/usr/bin/env node
// Usage: node import-fences/cli.ts [--config import-fences.config.ts] [--json]
// Checks the architecture rules of a config over a repository. See README.md.
// Exit codes: 0 no violation, 1 at least one violation, 2 bad usage or an invalid config.
import { relative } from 'node:path';
import { parseArgs } from 'node:util';
import { check } from './src/check.ts';
import { ConfigError, loadConfig } from './src/config.ts';
import { diskSource } from './src/files.ts';
import { formatText } from './src/report.ts';

const USAGE = 'usage: node import-fences/cli.ts [--config <import-fences.config.ts>] [--json]';

async function main(): Promise<number> {
  let values: { config?: string; json?: boolean; help?: boolean };
  try {
    ({ values } = parseArgs({ options: { config: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } }));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n${USAGE}\n`);
    return 2;
  }
  if (values.help === true) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const configPath = values.config ?? 'import-fences.config.ts';
  try {
    const { config, root } = await loadConfig(configPath);
    const result = check(config, diskSource(root, config.ignore), relative(root, configPath) || configPath);
    process.stdout.write(values.json === true ? `${JSON.stringify(result, null, 2)}\n` : formatText(result));
    return result.violations.length === 0 ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error instanceof ConfigError ? '' : 'error: '}${(error as Error).message}\n`);
    return 2;
  }
}

process.exitCode = await main();
