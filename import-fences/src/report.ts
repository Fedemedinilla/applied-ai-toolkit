import type { CheckResult } from './check.ts';

/** One line per violation, `file:line:column  rule  reason`, then a summary line. */
export function formatText(result: CheckResult): string {
  const lines = result.violations.map((v) => {
    const place = v.line > 0 ? `${v.file}:${v.line}:${v.column}` : v.file;
    return `${place}  ${v.rule}  ${v.reason}${v.why === undefined ? '' : `. Why: ${v.why}`}`;
  });
  const count = result.violations.length;
  lines.push(`import-fences: ${count} violation${count === 1 ? '' : 's'} in ${result.files} files, ${result.rules} rules`);
  return `${lines.join('\n')}\n`;
}
