// Prints the rule catalog as a Markdown table, for the README.
// Usage: node slop-lint/scripts/rules-table.ts
import { RULES } from '../src/rules.ts';

const cell = (s: string) => s.replace(/\|/gu, '\\|');
const budget = (r: (typeof RULES)[number]): string => {
  if (r.level === 1 && r.kind === 'pattern') return '0';
  if (r.level === 3) return 'anchor, else Tier 2';
  if (r.kind === 'pattern' && r.tier2Pool) return 'Tier 2: 2, no repeats';
  if (r.kind === 'pattern' && r.budget) return String(r.budget);
  return r.kind === 'structural' ? r.threshold : '0';
};

const rows = RULES.map((r) =>
  `| ${r.id} | ${cell(r.name)} | ${r.lang} | ${r.level} | ${r.severity} | ${budget(r)} | ${r.kind} | ${r.source.evidence.join(', ')} | ${cell(r.source.ref)} |`,
);
process.stdout.write(
  ['| id | rule | lang | level | severity | budget | kind | evidence | source |', '|---|---|---|---|---|---|---|---|---|', ...rows].join('\n') + '\n',
);
