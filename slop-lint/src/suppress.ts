/**
 * Inline suppression in Markdown mode: the directives that name rule ids.
 *
 *   <!-- slop-lint-disable LEX-03, EST-10: quoted from the posting -->  ...  <!-- slop-lint-enable -->
 *   <!-- slop-lint-disable-next-line LEX-03 -->
 *
 * The rules run on the text as if the directive were not there, so budgets, the Tier 2 pool and
 * the overlap between rules do not change. Afterwards a finding of a named rule that starts
 * inside the directive's range is moved from `findings` to `suppressed`. It is kept, with the
 * place of the directive that suppressed it, so the report still says what was waved through.
 *
 * Three things are reported as directive problems, each at the directive's own position:
 *   SUP-01  a suppression no finding used. Left alone, it stays behind after the sentence is
 *           fixed and silently covers the next finding of that rule in its range.
 *   SUP-02  a suppression that was refused: of a rule whose severity is disqualify, or a mask
 *           (a directive without a rule id) when the config turns masks off.
 *   SUP-03  a directive that cannot be read or names a rule that does not apply.
 */
import type { Directive, DirectiveIssue } from './markdown.ts';
import { lineColumn } from './text.ts';
import type { Finding, Rule, SuppressedFinding } from './types.ts';

export interface DirectiveRule {
  id: 'SUP-01' | 'SUP-02' | 'SUP-03';
  name: string;
  message: string;
  suggestion: string;
}

/** The directive checks. They are not prose rules: they have no place in the catalog, the score or the counts. */
export const DIRECTIVE_RULES: readonly DirectiveRule[] = [
  {
    id: 'SUP-01',
    name: 'Unused suppression',
    message: 'This suppression matches no finding.',
    suggestion: 'Delete the directive, or the rule id that matches nothing.',
  },
  {
    id: 'SUP-02',
    name: 'Suppression refused',
    message: 'This suppression was not applied.',
    suggestion: 'Fix the text, or change the rule for these files in slop-lint.config.json, where the change is reviewed.',
  },
  {
    id: 'SUP-03',
    name: 'Invalid directive',
    message: 'This directive cannot be applied.',
    suggestion: 'Name rule ids as --list-rules prints them, separated by commas, with an optional reason after a colon.',
  },
];

export const isDirectiveRuleId = (id: string): boolean => DIRECTIVE_RULES.some((r) => r.id === id);

export interface SuppressOptions {
  /** Lets a directive suppress a rule whose severity is disqualify. */
  allowDisqualify: boolean;
}

export interface Suppressed {
  kept: Finding[];
  suppressed: SuppressedFinding[];
  problems: Finding[];
}

interface Range {
  id: string;
  from: number;
  to: number;
  directive: Directive;
  used: boolean;
}

/**
 * Applies the directives to the findings of one document. `rules` are the rules that ran;
 * `source` is the input and `starts` its line starts, for the positions of the problems.
 */
export function applyDirectives(
  findings: readonly Finding[],
  directives: readonly Directive[],
  issues: readonly DirectiveIssue[],
  rules: readonly Rule[],
  options: SuppressOptions,
  source: string,
  starts: readonly number[],
): Suppressed {
  const byId = new Map(rules.map((r) => [r.id, r]));
  const problems: Finding[] = [];
  const problem = (id: DirectiveRule['id'], at: { start: number; end: number }, detail: string): void => {
    const rule = DIRECTIVE_RULES.find((r) => r.id === id);
    if (!rule) return;
    const { line, column } = lineColumn(starts, at.start);
    problems.push({
      ruleId: id,
      level: 2,
      severity: 'low',
      start: at.start,
      end: at.end,
      line,
      column,
      match: source.slice(at.start, at.end),
      message: rule.message,
      suggestion: rule.suggestion,
      detail,
    });
  };
  for (const issue of issues) problem(issue.kind === 'invalid' ? 'SUP-03' : 'SUP-02', issue, issue.why);

  const ranges: Range[] = [];
  const open: Range[] = [];
  for (const d of directives) {
    if (d.kind === 'enable') {
      const closing = d.ids.length === 0 ? [...open] : d.ids.flatMap((id) => open.filter((r) => r.id === id));
      for (const id of d.ids) {
        if (!open.some((r) => r.id === id)) problem('SUP-03', d, `no slop-lint-disable of ${id} is open here`);
      }
      for (const range of closing) {
        range.to = d.start;
        open.splice(open.indexOf(range), 1);
      }
      continue;
    }
    for (const id of d.ids) {
      const rule = byId.get(id);
      if (!rule) {
        problem('SUP-03', d, `${id} is not a rule that applies to this file: it does not exist, or the config turns it off`);
      } else if (rule.severity === 'disqualify' && !options.allowDisqualify) {
        problem('SUP-02', d, `${id} has the severity disqualify, which a comment in the text cannot suppress; suppressions.allowDisqualify in the config allows it`);
      } else {
        const [from, to] = d.kind === 'disable' ? [d.end, Infinity] : (d.nextLine ?? [d.end, d.end]);
        const range: Range = { id, from, to, directive: d, used: false };
        ranges.push(range);
        if (d.kind === 'disable') open.push(range);
      }
    }
  }

  const kept: Finding[] = [];
  const suppressed: SuppressedFinding[] = [];
  for (const f of findings) {
    const range = ranges.find((r) => r.id === f.ruleId && f.start >= r.from && f.start < r.to);
    if (!range) {
      kept.push(f);
      continue;
    }
    range.used = true;
    const { line, column } = lineColumn(starts, range.directive.start);
    const by: SuppressedFinding['suppressedBy'] = { line, column };
    if (range.directive.reason !== undefined) by.reason = range.directive.reason;
    suppressed.push({ ...f, suppressedBy: by });
  }
  for (const range of ranges) {
    if (!range.used) problem('SUP-01', range.directive, `no ${range.id} finding ${range.directive.kind === 'disable' ? 'in its range' : 'on the next line'}`);
  }
  problems.sort((a, b) => a.start - b.start || a.ruleId.localeCompare(b.ruleId));
  return { kept, suppressed, problems };
}
