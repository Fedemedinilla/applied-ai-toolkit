// The scope of a diff-scoped audit, for the audit-diff workflow (.claude/workflows/audit-diff.js).
//
//   node test/audit-scope/cli.ts [--base <ref>] [--json] [--out <file>]
//
// --base defaults to origin/main. Without --json it prints a short summary; --json prints the scope
// as JSON; --out writes the JSON to a file and prints the summary. Exit codes: 0 on success, 2 when
// an option is wrong or git cannot answer (a base that does not exist, not a repository).

import { writeFileSync } from 'node:fs';
import { formatText, gitScope, GitError } from './scope.ts';

class UsageError extends Error {}

function options(args: readonly string[]): { base: string; json: boolean; out: string | undefined } {
  let base = 'origin/main';
  let json = false;
  let out: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--json') json = true;
    else if (flag === '--base' || flag === '--out') {
      const value = args[++i];
      if (value === undefined || value.startsWith('--')) throw new UsageError(`${flag} needs a value`);
      if (flag === '--base') base = value;
      else out = value;
    } else throw new UsageError(`unknown option ${flag}`);
  }
  return { base, json, out };
}

try {
  const { base, json, out } = options(process.argv.slice(2));
  const scope = gitScope({ cwd: process.cwd(), base });
  const text = `${JSON.stringify(scope, null, 2)}\n`;
  if (out !== undefined) writeFileSync(out, text);
  process.stdout.write(json && out === undefined ? text : formatText(scope));
} catch (error) {
  if (!(error instanceof UsageError || error instanceof GitError)) throw error;
  process.stderr.write(`audit-scope: ${error.message}\n`);
  process.exitCode = 2;
}
