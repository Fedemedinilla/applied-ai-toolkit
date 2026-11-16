// Prints the rule catalog as a Markdown table for the README, then the rules only some genres run.
// Usage: node slop-lint/scripts/rules-table.ts
import { GENRES, resolveRules } from '../src/genres.ts';
import { GENRE_RULES, RULES } from '../src/rules.ts';

const cell = (s: string) => s.replace(/\|/gu, '\\|');
const budget = (r: (typeof RULES)[number]): string => {
  if (r.level === 1 && r.kind === 'pattern') return '0';
  if (r.level === 3) return 'anchor, else Tier 2';
  if (r.kind === 'pattern' && r.tier2Pool) return 'Tier 2: 2, no repeats';
  if (r.kind === 'pattern' && r.budget) return String(r.budget);
  return r.kind === 'structural' ? r.threshold : '0';
};
const genresOf = (id: string): string => GENRES.filter((g) => resolveRules(RULES, g).some((r) => r.id === id)).join(', ');

// A rule's weaker alternatives add their severity, evidence and source after the rule's own.
const weaker = (r: (typeof RULES)[number]) => (r.kind === 'pattern' ? r.weaker : undefined);
const severity = (r: (typeof RULES)[number]): string => {
  const w = weaker(r);
  return w ? `${r.severity}; ${w.severity} for ${w.label}` : r.severity;
};
const evidence = (r: (typeof RULES)[number]): string => {
  const w = weaker(r);
  return r.source.evidence.join(', ') + (w ? `; ${w.source.evidence.join(', ')} for ${w.label}` : '');
};
const ref = (r: (typeof RULES)[number]): string => {
  const w = weaker(r);
  return r.source.ref + (w ? `; ${w.source.ref}` : '');
};
const rows = RULES.map((r) => `| ${r.id} | ${cell(r.name)} | ${r.lang} | ${r.level} | ${cell(severity(r))} | ${budget(r)} | ${r.kind} | ${cell(evidence(r))} | ${cell(ref(r))} |`);
const genreRows = GENRE_RULES.map((r) =>
  `| ${r.id} | ${cell(r.name)} | ${genresOf(r.id)} | ${r.lang} | ${r.level} | ${r.severity} | ${budget(r)} | ${r.kind} | ${r.source.evidence.join(', ')} | ${cell(r.source.ref)} |`,
);
process.stdout.write(
  [
    '| id | rule | lang | level | severity | budget | kind | evidence | source |',
    '|---|---|---|---|---|---|---|---|---|',
    ...rows,
    '',
    '| id | rule | genres | lang | level | severity | budget | kind | evidence | source |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...genreRows,
  ].join('\n') + '\n',
);
