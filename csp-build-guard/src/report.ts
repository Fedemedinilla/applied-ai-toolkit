/** The human-readable report. --json prints the GuardReport object itself. */
import type { PageWeight } from './checks/js-budget.ts';
import type { GuardReport } from './types.ts';

const HEAVIEST = 5;
const LABEL = { pass: 'PASS', fail: 'FAIL', skip: 'SKIP' } as const;
const kb = (bytes: number) => (bytes / 1000).toFixed(1).padStart(6);

export function formatReport(report: GuardReport, displayDir: string): string {
  const lines = [`csp-build-guard: ${displayDir} (${report.pages} HTML page${report.pages === 1 ? '' : 's'})`];
  const width = Math.max(...report.checks.map((c) => c.id.length));
  for (const check of report.checks) {
    lines.push(`${LABEL[check.status]} ${check.id.padEnd(width)}  ${check.summary}`);
    for (const failure of check.failures) lines.push(`     - ${failure.message}`);
    if (check.id === 'js-budget' && Array.isArray(check.details)) {
      // The heaviest pages only; --json has every page with its files.
      const weights = [...(check.details as PageWeight[])].sort((x, y) => y.total.gzip - x.total.gzip);
      for (const w of weights.slice(0, HEAVIEST)) {
        const limits = [w.gzipKb === undefined ? '' : `gzip <= ${w.gzipKb}`, w.brotliKb === undefined ? '' : `brotli <= ${w.brotliKb}`].filter(Boolean).join(', ');
        lines.push(`       ${kb(w.total.gzip)} kB gzip ${kb(w.total.brotli)} kB brotli  ${w.page}  (${limits} kB)`);
      }
      if (weights.length > HEAVIEST) lines.push(`       ... ${weights.length - HEAVIEST} lighter pages in --json`);
    }
  }
  const failed = report.checks.filter((c) => c.status === 'fail').length;
  const ran = report.checks.filter((c) => c.status !== 'skip').length;
  lines.push(failed ? `FAILED: ${failed} of ${ran} checks` : `OK: ${ran} checks passed, ${report.checks.length - ran} skipped`);
  return `${lines.join('\n')}\n`;
}
