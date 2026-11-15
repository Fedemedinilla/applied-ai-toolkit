// @vitest-environment jsdom
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { classification } from '../src/classification.ts';
import { extraction } from '../src/extraction.ts';
import { GateRefusal } from '../src/gate.ts';
import { escapeHtml, renderComparisonReport, renderRunReport } from '../src/report.ts';
import { RUN_FORMAT, scoreItems, type RunResult, type StoredRun } from '../src/run.ts';

/** Strings a model, a judge or a file could put in a run to break out of the page. */
const XSS = [
  '<script>alert(1)</script>',
  '"><img src=x onerror=alert(1)>',
  "' onmouseover='alert(1)",
  '</pre></details></td></tr></table><script>alert(2)</script>',
  '</style><script>alert(3)</script>',
  '</title><svg onload=alert(4)>',
  '<!-- --><iframe src="javascript:alert(5)"></iframe>',
  '<a href="javascript:alert(6)">x</a>',
  '&lt;script&gt;alert(7)&lt;/script&gt;',
  '<ScRiPt src=//evil.example/x.js></sCrIpT>',
  '<meta http-equiv="refresh" content="0;url=https://evil.example/">',
  '<base href="https://evil.example/">',
  '<link rel=stylesheet href=https://evil.example/x.css>',
  '<style>body{background:url(https://evil.example/p)}</style>',
  '<form action=https://evil.example/><input name=q></form>',
  '<details open ontoggle=alert(8)>',
  ' <script>alert(9)</script> ',
  '<scr\0ipt>alert(10)</scr\0ipt>',
  '${alert(11)} {{constructor.constructor("alert(12)")()}}',
  '<math><mtext><table><mglyph><style><img src onerror=alert(13)>',
];

const ALLOWED_TAGS = new Set(['HTML', 'HEAD', 'META', 'TITLE', 'STYLE', 'BODY', 'H1', 'H2', 'H3', 'P', 'DIV', 'TABLE', 'TBODY', 'TR', 'TH', 'TD', 'SPAN', 'STRONG', 'DETAILS', 'SUMMARY', 'PRE']);
const ALLOWED_ATTRIBUTES = new Set(['class', 'lang', 'charset', 'http-equiv', 'content', 'name']);

/** A run where every string a model or a file controls is one of the payloads. */
function hostileRun(label: string, offset = 0): StoredRun {
  const pick = (i: number) => XSS[(i + offset) % XSS.length]!;
  const results: RunResult[] = XSS.map((payload, i) => ({
    case: `case ${i} ${payload}`,
    sample: 1,
    status: 'scored',
    pass: i % 3 === 0,
    metrics: { [`metric ${pick(i)}`]: i },
    input: `input ${pick(i + 1)}`,
    output: `output ${pick(i + 2)}`,
    detail: `detail ${pick(i + 3)}`,
  }));
  results.push({ case: `failed ${pick(0)}`, sample: 1, status: 'failed', pass: null, metrics: {}, detail: pick(1) });
  return {
    format: RUN_FORMAT,
    rubric: { name: `rubric ${pick(4)}`, version: `v ${pick(5)}` },
    label: `${label} ${pick(6)}`,
    results,
    tables: [{ title: `title ${pick(7)}`, columns: ['a', `col ${pick(8)}`], rows: XSS.map((p, i) => [p, i]), note: `note ${pick(9)}` }],
  };
}

function assertInert(html: string) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const el of doc.querySelectorAll('*')) {
    expect(ALLOWED_TAGS.has(el.tagName), `unexpected <${el.tagName.toLowerCase()}>`).toBe(true);
    for (const attr of el.attributes) expect(ALLOWED_ATTRIBUTES.has(attr.name), `unexpected attribute ${attr.name} on <${el.tagName.toLowerCase()}>`).toBe(true);
  }
  expect(doc.querySelectorAll('style')).toHaveLength(1);
  expect(doc.querySelectorAll('meta')).toHaveLength(3);
  expect(doc.querySelectorAll('title')).toHaveLength(1);
  // The stylesheet is the page's own: no payload reached it.
  expect(doc.querySelector('style')!.textContent).not.toMatch(/evil|alert|url\(/);
  return doc;
}

describe('escapeHtml', () => {
  it('escapes the five characters and replaces NUL', () => {
    expect(escapeHtml(`<a href="x" title='y'>&amp;\0</a>`)).toBe('&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;amp;�&lt;/a&gt;');
  });
});

describe('the HTML report holds against hostile strings', () => {
  it('renders every payload as text, in a run report', () => {
    const html = renderRunReport(hostileRun('run'));
    const doc = assertInert(html);
    const text = doc.body.textContent ?? '';
    for (const payload of XSS) expect(text).toContain(payload.replace(/\0/g, '�'));
    expect(doc.title).toBe(`Eval report: run ${XSS[6]}`);
    expect(html).not.toMatch(/<script|<img|<iframe|<svg|<a |<link|<base|<form|<math/i);
  });

  it('renders every payload as text, in a comparison report', () => {
    const html = renderComparisonReport(hostileRun('base'), { ...hostileRun('cand', 0), label: `cand ${XSS[3]}` }, { allowMissing: true });
    const doc = assertInert(html);
    const text = doc.body.textContent ?? '';
    for (const payload of XSS) expect(text).toContain(payload.replace(/\0/g, '�'));
    expect(html).not.toMatch(/<script|<img|<iframe|<svg|<a |<link|<base|<form|<math/i);
  });

  it('carries a policy that allows only its own stylesheet, by hash', () => {
    const doc = assertInert(renderRunReport(hostileRun('run')));
    const csp = doc.querySelector('meta[http-equiv="Content-Security-Policy"]')!.getAttribute('content')!;
    const hash = createHash('sha256').update(doc.querySelector('style')!.textContent!).digest('base64');
    expect(csp).toBe(`default-src 'none'; style-src 'sha256-${hash}'; base-uri 'none'; form-action 'none'`);
  });
});

/** Not a file URL: under jsdom, `new URL(..., import.meta.url)` is the page's URL class and loses the path. */
const HERE = import.meta.dirname;
const LABELS = ['price', 'hours', 'repair', 'other'];
const exampleItems = (name: string) => JSON.parse(readFileSync(join(HERE, '..', 'example', `${name}.json`), 'utf8')) as unknown[];
const baseline = scoreItems(classification({ labels: LABELS }), 'main', exampleItems('tickets-baseline'));
const candidate = scoreItems(classification({ labels: LABELS }), 'pr', exampleItems('tickets-candidate'));
/** The text of each cell of a row, without the folded input and output. */
const cells = (row: Element) =>
  [...row.querySelectorAll('th, td')].map((c) => {
    const copy = c.cloneNode(true) as Element;
    for (const d of copy.querySelectorAll('details')) d.remove();
    return (copy.textContent ?? '').trim();
  });

describe('the report of one run', () => {
  const html = renderRunReport(candidate);
  const doc = assertInert(html);
  const tables = [...doc.querySelectorAll('table')];

  it('is one file with no script and nothing to fetch', () => {
    expect(html.startsWith('<!doctype html>\n<html lang="en">')).toBe(true);
    expect(html).not.toMatch(/https?:|src=|href=|url\(|@import|<script/i);
  });

  it('shows the totals with the interval', () => {
    expect(doc.querySelector('h1')!.textContent).toBe('Eval report: pr');
    expect(cells(tables[0]!.rows[1]!)).toEqual(['run', 'pr', '40', '26', '65%', '50% to 78%', '0', '0', '0']);
    expect(doc.body.textContent).toContain('Rubric: classification, version 1 single [hours, other, price, repair].');
  });

  it('shows the rubric tables and the metric means', () => {
    expect([...doc.querySelectorAll('h2, h3')].map((x) => x.textContent)).toEqual(['Totals', 'Metrics', 'Per class (pr)', 'Confusion matrix (pr)', 'Results']);
    expect(cells(tables[1]!.rows[1]!)).toEqual(['out_of_set', '0.05']);
    expect(cells(tables[3]!.rows[0]!)).toEqual(['expected \\ predicted', 'hours', 'other', 'price', 'repair', '(out of set)']);
  });

  it('lists every result, the failing ones first', () => {
    const rows = [...tables.at(-1)!.rows].slice(1).map(cells);
    expect(rows).toHaveLength(40);
    const states = rows.map((r) => r[2]);
    expect(states.slice(0, 14).every((s) => s === 'fail')).toBe(true);
    expect(states.slice(14).every((s) => s === 'pass')).toBe(true);
    expect(rows[0]).toEqual(['ticket-03', '2', 'fail', 'expected price, got other']);
    const first = tables.at(-1)!.rows[1]!;
    expect([...first.querySelectorAll('pre')].map((p) => p.textContent)).toEqual(['Is the full service more than $40,000?', 'other']);
  });

  it('puts results that could not be scored between failing and passing', () => {
    const run = scoreItems(extraction, 'x', [
      { case: 'c', output: '{"a":1}', expected: { a: 1 } },
      { case: 'b', expected: { a: 1 }, error: 'timeout after 60 s' },
      { case: 'a', output: '{"a":2}', expected: { a: 1 } },
    ]);
    const rows = [...assertInert(renderRunReport(run)).querySelectorAll('table')].at(-1)!.rows;
    expect([...rows].slice(1).map((r) => cells(r).slice(0, 4))).toEqual([
      ['a', '1', 'fail', 'wrong: a'],
      ['b', '1', 'call failed', 'timeout after 60 s'],
      ['c', '1', 'pass', ''],
    ]);
  });

  it('is deterministic: the same run in any order gives the same bytes', () => {
    expect(renderRunReport(candidate)).toBe(html);
    const reversed = { ...candidate, results: [...candidate.results].reverse() };
    expect(renderRunReport(reversed)).toBe(html);
    expect(renderRunReport(JSON.parse(JSON.stringify(candidate)) as StoredRun)).toBe(html);
  });
});

describe('the report of a comparison', () => {
  const html = renderComparisonReport(baseline, candidate);
  const doc = assertInert(html);
  const tables = [...doc.querySelectorAll('table')];

  it('opens with the gate decision and both totals', () => {
    expect(doc.querySelector('h1')!.textContent).toBe('Eval comparison: pr against main');
    const verdict = doc.querySelector('.verdict.fail')!.textContent!;
    expect(verdict).toContain('Gate: fail (exit code 1)');
    expect(verdict).toContain('Difference in pass rate, candidate minus baseline: -30.0 points, 95% interval -45.9 to -12.7. Margin: 10.0 points.');
    expect(cells(tables[0]!.rows[1]!)).toEqual(['baseline', 'main', '40', '38', '95%', '83% to 99%', '0', '0', '0']);
    expect(cells(tables[0]!.rows[2]!)).toEqual(['candidate', 'pr', '40', '26', '65%', '50% to 78%', '0', '0', '0']);
  });

  it('lists results that got worse first, then failing in both, then fixed, then passing in both', () => {
    const rows = [...tables.at(-1)!.rows].slice(1).map((r) => cells(r).slice(0, 4));
    expect(rows).toHaveLength(40);
    const kinds = rows.map((r) => `${r[2]}>${r[3]}`);
    expect(kinds.slice(0, 13).every((k) => k === 'pass>fail')).toBe(true);
    expect(kinds[13]).toBe('fail>fail');
    expect(kinds[14]).toBe('fail>pass');
    expect(kinds.slice(15).every((k) => k === 'pass>pass')).toBe(true);
    expect(rows[0]).toEqual(['ticket-03', '2', 'pass', 'fail']);
  });

  it('is deterministic and refuses runs that cannot be compared', () => {
    expect(renderComparisonReport(baseline, candidate)).toBe(html);
    expect(html).not.toMatch(/https?:|src=|href=|url\(|@import|<script/i);
    expect(() => renderComparisonReport(baseline, { ...candidate, rubric: { name: 'extraction', version: '1' } })).toThrow(GateRefusal);
    expect(() => renderComparisonReport(baseline, { ...candidate, results: candidate.results.slice(1) })).toThrow(GateRefusal);
  });
});

describe('the scripts, end to end on the example files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'evals-report-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const script = (name: string) => join(HERE, '..', 'scripts', `${name}.ts`);
  const example = (name: string) => join(HERE, '..', 'example', name);
  const node = (...args: string[]) => {
    const { ANTHROPIC_API_KEY: _key, ...env } = process.env;
    return spawnSync(process.execPath, args, { encoding: 'utf8', env });
  };

  it('scores both example runs, gates them and writes the same report as the library', () => {
    const base = join(dir, 'base.json');
    const cand = join(dir, 'cand.json');
    const labels = ['--labels', LABELS.join(',')];
    expect(node(script('score'), 'classification', example('tickets-baseline.json'), base, ...labels, '--label', 'main').stdout).toContain('38/40 pass');
    expect(node(script('score'), 'classification', example('tickets-candidate.json'), cand, ...labels, '--label', 'pr').stdout).toContain('26/40 pass');
    expect(JSON.parse(readFileSync(base, 'utf8'))).toEqual(baseline);
    expect(node(script('gate'), base, cand).status).toBe(1);
    const out = join(dir, 'report.html');
    expect(node(script('report'), base, cand, out).status).toBe(0);
    expect(readFileSync(out, 'utf8')).toBe(renderComparisonReport(baseline, candidate));
    // An existing file is never written over, and a single run gets its own report.
    expect(node(script('report'), base, cand, out).status).toBe(2);
    expect(node(script('score'), 'classification', example('tickets-baseline.json'), base, ...labels).status).toBe(2);
    const single = join(dir, 'single.html');
    expect(node(script('report'), cand, single).status).toBe(0);
    expect(readFileSync(single, 'utf8')).toBe(renderRunReport(candidate));
  });

  it('scores the extraction example and refuses an unknown rubric or a comparison across rubrics', () => {
    const book = join(dir, 'book.json');
    const r = node(script('score'), 'extraction', example('bookings.json'), book);
    expect(r.stdout).toContain('extraction "run": 3/6 pass');
    expect(node(script('score'), 'sentiment', example('bookings.json'), join(dir, 'x.json')).status).toBe(2);
    expect(node(script('score'), 'classification', example('bookings.json'), join(dir, 'y.json')).status).toBe(2);
    const refused = node(script('report'), join(dir, 'base.json'), book, join(dir, 'z.html'));
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain('different rubrics');
  });
});
