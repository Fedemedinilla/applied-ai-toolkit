/**
 * A stored run, or a comparison of two, as one HTML file.
 *
 * The file is self-contained: one inline stylesheet, no script, no image, no
 * font, no link. It opens from disk or from a CI artifact and reads the same
 * offline. Piece texts sit in <details> elements, which fold and unfold
 * without script.
 *
 * Everything a model or a file produced is escaped. The page is assembled
 * with the `h` template tag, which escapes every interpolated string and
 * lets through only fragments that `h` itself built, so there is no call site
 * where forgetting to escape is possible. As a second line, the page carries
 * a Content-Security-Policy that allows nothing but its own stylesheet, by
 * hash: a script that got past the escaping would still not run.
 *
 * The output is a pure function of the runs: no clock, no random id, and
 * every list sorted in code-unit order. The same runs give the same bytes.
 */
import { createHash } from 'node:crypto';
import { gate, type GateOptions, type GateResult } from './gate.ts';
import type { Table } from './rubric.ts';
import { byCodeUnit, summarize, type RunResult, type RunSummary, type StoredRun } from './run.ts';

class Safe {
  readonly html: string;
  constructor(html: string) {
    this.html = html;
  }
}

/** Escapes text for element content and for a quoted attribute. NUL becomes U+FFFD: HTML has no way to write it. */
export function escapeHtml(text: string): string {
  return text
    .replace(/\0/g, '�')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

type Part = Safe | string | number | readonly Part[];

const render = (p: Part): string => (p instanceof Safe ? p.html : typeof p === 'object' ? p.map(render).join('') : escapeHtml(String(p)));

/** The only way markup is built here. Strings and numbers are escaped; only what `h` returned passes as markup. */
function h(strings: TemplateStringsArray, ...values: Part[]): Safe {
  return new Safe(strings.reduce((out, s, i) => out + s + (i < values.length ? render(values[i]!) : ''), ''));
}

const STYLE = `
:root { color-scheme: light dark; --fg: #1a1a1a; --bg: #ffffff; --muted: #5c5c5c; --line: #d9d9d9; --soft: #f4f4f4; --bad: #a4262c; --good: #1e6b34; --warn: #7a5200; }
@media (prefers-color-scheme: dark) { :root { --fg: #ececec; --bg: #161616; --muted: #a8a8a8; --line: #3a3a3a; --soft: #222222; --bad: #ff9a9a; --good: #8fd6a4; --warn: #f0c36a; } }
body { margin: 0 auto; padding: 24px 16px 64px; max-width: 1100px; font: 15px/1.5 system-ui, sans-serif; color: var(--fg); background: var(--bg); }
h1 { font-size: 22px; margin: 0 0 4px; } h2 { font-size: 17px; margin: 32px 0 8px; } h3 { font-size: 15px; margin: 20px 0 6px; }
p { margin: 6px 0; } .muted { color: var(--muted); }
.wrap { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
th, td { text-align: left; vertical-align: top; padding: 6px 10px; border-bottom: 1px solid var(--line); }
th { font-weight: 600; background: var(--soft); white-space: nowrap; } td.n, th.n { text-align: right; }
.verdict { border: 1px solid var(--line); border-left-width: 6px; padding: 10px 14px; margin: 12px 0; }
.verdict.fail { border-left-color: var(--bad); } .verdict.pass { border-left-color: var(--good); } .verdict.inconclusive { border-left-color: var(--warn); }
.tag { font-weight: 600; white-space: nowrap; } .tag.fail { color: var(--bad); } .tag.pass { color: var(--good); } .tag.none { color: var(--warn); }
details { margin: 2px 0; } summary { cursor: pointer; color: var(--muted); }
pre { white-space: pre-wrap; overflow-wrap: anywhere; margin: 6px 0; padding: 8px 10px; background: var(--soft); font: 13px/1.45 ui-monospace, monospace; }
`;

const CSP = `default-src 'none'; style-src 'sha256-${createHash('sha256').update(STYLE).digest('base64')}'; base-uri 'none'; form-action 'none'`;

const pct = (x: number) => (Number.isNaN(x) ? '-' : `${Math.round(x * 100)}%`);
const points = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}`;
const num = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(2));

const STATE_OF: Record<string, { text: string; cls: string }> = {
  pass: { text: 'pass', cls: 'pass' },
  fail: { text: 'fail', cls: 'fail' },
  'no-output': { text: 'no output', cls: 'none' },
  failed: { text: 'call failed', cls: 'none' },
  absent: { text: 'absent', cls: 'none' },
};
const stateOf = (r: RunResult | undefined) => (!r ? 'absent' : r.status !== 'scored' ? r.status : r.pass ? 'pass' : 'fail');
const tag = (r: RunResult | undefined) => {
  const s = STATE_OF[stateOf(r)]!;
  return h`<span class="tag ${s.cls}">${s.text}</span>${r?.split ? h` <span class="muted">(judges split)</span>` : ''}`;
};

function totals(summaries: readonly { name: string; s: RunSummary }[]): Safe {
  return h`<div class="wrap"><table>
<tr><th>run</th><th>label</th><th class="n">scored</th><th class="n">passed</th><th class="n">pass rate</th><th>95% CI</th><th class="n">call failed</th><th class="n">no output</th><th class="n">judges split</th></tr>
${summaries.map(({ name, s }) => h`<tr><td>${name}</td><td>${s.label}</td><td class="n">${s.scored}</td><td class="n">${s.passes}</td><td class="n">${pct(s.rate)}</td><td>${s.scored ? `${pct(s.ci[0])} to ${pct(s.ci[1])}` : '-'}</td><td class="n">${s.failed}</td><td class="n">${s.noOutput}</td><td class="n">${s.split}</td></tr>\n`)}</table></div>`;
}

function metrics(summaries: readonly { name: string; s: RunSummary }[]): Safe | string {
  const names = [...new Set(summaries.flatMap(({ s }) => Object.keys(s.metrics)))].sort(byCodeUnit);
  if (names.length === 0) return '';
  return h`<h2>Metrics</h2>
<p class="muted">The mean of each metric over the scored results. Metrics are reported and do not decide pass or fail.</p>
<div class="wrap"><table>
<tr><th>metric</th>${summaries.map(({ name }) => h`<th class="n">${name}</th>`)}</tr>
${names.map((m) => h`<tr><td>${m}</td>${summaries.map(({ s }) => h`<td class="n">${m in s.metrics ? num(s.metrics[m]!) : '-'}</td>`)}</tr>\n`)}</table></div>`;
}

function rubricTables(name: string, tables: readonly Table[]): Safe | string {
  if (tables.length === 0) return '';
  return h`${tables.map(
    (t) => h`<h3>${t.title} (${name})</h3>
<div class="wrap"><table>
<tr>${t.columns.map((c) => h`<th>${c}</th>`)}</tr>
${t.rows.map((row) => h`<tr>${row.map((v) => (typeof v === 'number' ? h`<td class="n">${v}</td>` : h`<td>${v}</td>`))}</tr>\n`)}</table></div>
${t.note ? h`<p class="muted">${t.note}</p>` : ''}`,
  )}`;
}

function texts(name: string, r: RunResult | undefined): Safe | string {
  if (!r || (r.input === undefined && r.output === undefined)) return '';
  return h`<details><summary>${name}: input and output</summary>${r.input === undefined ? '' : h`<pre>${r.input}</pre>`}${r.output === undefined ? '' : h`<pre>${r.output}</pre>`}</details>`;
}

/** Failing first, then what could not be scored, then passing; inside each, by case and sample. */
const RANK: Record<string, number> = { fail: 0, failed: 1, 'no-output': 2, absent: 3, pass: 4 };
const byCase = (a: { case: string; sample: number }, b: { case: string; sample: number }) => byCodeUnit(a.case, b.case) || a.sample - b.sample;

function singleRows(run: StoredRun): Safe {
  const rows = [...run.results].sort((a, b) => RANK[stateOf(a)]! - RANK[stateOf(b)]! || byCase(a, b));
  return h`<h2>Results</h2>
<p class="muted">Failing results first, then results that could not be scored, then passing ones.</p>
<div class="wrap"><table>
<tr><th>case</th><th class="n">sample</th><th>result</th><th>detail</th></tr>
${rows.map((r) => h`<tr><td>${r.case}</td><td class="n">${r.sample}</td><td>${tag(r)}</td><td>${r.detail ?? ''}${texts('result', r)}</td></tr>\n`)}</table></div>`;
}

function pairRows(baseline: StoredRun, candidate: StoredRun): Safe {
  const id = (r: RunResult) => `${r.case}\0${r.sample}`;
  const b = new Map(baseline.results.map((r) => [id(r), r]));
  const c = new Map(candidate.results.map((r) => [id(r), r]));
  const pairs = [...new Set([...b.keys(), ...c.keys()])].map((k) => {
    const base = b.get(k);
    const cand = c.get(k);
    const one = (base ?? cand)!;
    const bs = stateOf(base);
    const cs = stateOf(cand);
    // Got worse, then failing on both sides, then not scored, then fixed, then passing on both.
    const rank = bs === 'pass' && cs === 'fail' ? 0 : cs === 'fail' ? 1 : cs !== 'pass' ? 2 : bs !== 'pass' ? 3 : 4;
    return { case: one.case, sample: one.sample, base, cand, rank };
  });
  pairs.sort((x, y) => x.rank - y.rank || byCase(x, y));
  return h`<h2>Results, case by case</h2>
<p class="muted">Results that got worse first, then results failing in both runs, then results that could not be scored, then fixed ones, then results passing in both.</p>
<div class="wrap"><table>
<tr><th>case</th><th class="n">sample</th><th>baseline</th><th>candidate</th><th>detail</th></tr>
${pairs.map((p) => h`<tr><td>${p.case}</td><td class="n">${p.sample}</td><td>${tag(p.base)}</td><td>${tag(p.cand)}</td><td>${p.cand?.detail ?? p.base?.detail ?? ''}${texts('baseline', p.base)}${texts('candidate', p.cand)}</td></tr>\n`)}</table></div>`;
}

function verdict(g: GateResult): Safe {
  return h`<div class="verdict ${g.state}">
<p><strong>Gate: ${g.state}</strong> (exit code ${g.exitCode})</p>
<p>${g.reason[0]!.toUpperCase() + g.reason.slice(1)}.</p>
<p>Difference in pass rate, candidate minus baseline: ${points(g.difference.estimate)} points, 95% interval ${points(g.difference.lower)} to ${points(g.difference.upper)}. Margin: ${points(g.margin).slice(1)} points.</p>
</div>`;
}

function page(title: string, rubric: StoredRun['rubric'], body: Safe): string {
  return h`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${new Safe(STYLE)}</style>
</head>
<body>
<h1>${title}</h1>
<p class="muted">Rubric: ${rubric.name}, version ${rubric.version}. Every rate has a 95% Wilson interval.</p>
${body}
</body>
</html>
`.html;
}

/** The report of one run. */
export function renderRunReport(run: StoredRun): string {
  const s = [{ name: 'run', s: summarize(run) }];
  return page(`Eval report: ${run.label}`, run.rubric, h`<h2>Totals</h2>
${totals(s)}
${metrics(s)}
${rubricTables(run.label, run.tables)}
${singleRows(run)}`);
}

/**
 * The report of a comparison, with the gate's decision on top. The runs must
 * be comparable: `GateRefusal` is thrown otherwise, as in the gate.
 */
export function renderComparisonReport(baseline: StoredRun, candidate: StoredRun, opts: GateOptions = {}): string {
  const g = gate(baseline, candidate, opts);
  const s = [
    { name: 'baseline', s: g.baseline },
    { name: 'candidate', s: g.candidate },
  ];
  return page(`Eval comparison: ${candidate.label} against ${baseline.label}`, baseline.rubric, h`${verdict(g)}
<h2>Totals</h2>
${totals(s)}
${metrics(s)}
${rubricTables(`baseline, ${baseline.label}`, baseline.tables)}
${rubricTables(`candidate, ${candidate.label}`, candidate.tables)}
${pairRows(baseline, candidate)}`);
}
