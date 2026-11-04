// The Markdown report: the check version and the before and after version, with counts that carry
// their denominator and evidence notes that cannot inject Markdown.

import { describe, expect, it } from 'vitest';
import { ackPostChange, ackPreChange, closeRun, postChangePending, recordBaseline, setEvidence, setState, type Run, type State } from '../src/run.ts';
import { md, reportMarkdown } from '../src/report.ts';
import { at, loadCatalogue, ok, runWith } from './helpers.ts';

const catalogue = loadCatalogue();

function mark(run: Run, id: string, state: State, evidence = ''): Run {
  let r = ok(setState(catalogue, run, id, state, at(1)));
  if (evidence) r = ok(setEvidence(catalogue, r, id, evidence, at(1)));
  return r;
}

function externalRun(): Run {
  let run: Run = { ...runWith(catalogue, 'wordpress', ['own-mail']), site: { name: 'Example Workshop', url: 'https://www.workshop.test/' } };
  run = mark(run, 'EXT-05', 'fail', 'no DMARC record');
  run = mark(run, 'EXT-02', 'fail', 'generator tag shows 6.1');
  run = mark(run, 'VIS-06', 'fail');
  run = mark(run, 'EXT-07', 'pass', 'tls.json');
  run = mark(run, 'EXT-17', 'pass');
  return run;
}

describe('md()', () => {
  it('collapses lines and escapes the characters that would add markup', () => {
    expect(md('line one\n# not a heading\n[link](https://x.test) <script> a|b *x* _y_ `z`')).toBe(
      'line one # not a heading \\[link\\](https://x.test) \\<script\\> a\\|b \\*x\\* \\_y\\_ \\`z\\`',
    );
  });
});

describe('the check report (template A)', () => {
  const text = reportMarkdown(catalogue, externalRun(), 'check', at(60));

  it('opens with the site and says what was not looked at', () => {
    expect(text.startsWith('# Site status: Example Workshop\n\nSite: https://www.workshop.test/. Date: 2026-11-04.')).toBe(true);
    expect(text).toContain('The dashboard and the hosting were not opened');
    expect(text).toContain('## What cannot be seen from outside');
  });

  it('gives every count with its denominator, and splits the grey ones', () => {
    expect(text).toContain('- ▲ Fix now: 1 to fix now, of 43 applicable');
    expect(text).toContain('- ■ Review: 1 to review, of 43 applicable');
    expect(text).toContain('- ◆ Optional improvement: 1 optional improvement, of 43 applicable');
    expect(text).toContain('- ● Good: 1 good, of 43 applicable');
    expect(text).toContain('- ○ Could not check: 39 not checked, of 43 applicable');
    expect(text).toContain('- Of the ones not checked: 38 not marked yet, 1 passed without an evidence note.');
  });

  it('lists findings from urgent to good, with the evidence and what to do', () => {
    const order = ['### ▲ Fix now (1)', '### ■ Review (1)', '### ◆ Optional improvement (1)', '## ● What is good (1)', '## ○ Could not check (39)'].map((h) => text.indexOf(h));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text).toContain('- **EXT-05 SPF, DKIM, DMARC and MX.** Can someone send mail pretending to be the domain? State: Fails. Evidence: no DMARC record What to do: Publish SPF');
    expect(text).toContain('- **EXT-17 HTTPS and canonical host.** Does every address land on one host with the padlock? Why: marked Passed with no evidence note.');
  });

  it('does not let an evidence note add a heading, a link or HTML', () => {
    const run = mark(externalRun(), 'EXT-09', 'fail', 'Server: Apache\n## Pwned\n<img src=x onerror=alert(1)> [click](https://evil.test)');
    const out = reportMarkdown(catalogue, run, 'check', at(60));
    expect(out).not.toMatch(/^## Pwned/mu);
    expect(out).not.toMatch(/(?<!\\)<img/u);
    expect(out).not.toMatch(/(?<!\\)\[click\]\(/u);
    expect(out).toContain('Evidence: Server: Apache ## Pwned \\<img src=x onerror=alert(1)\\> \\[click\\](https://evil.test)');
  });

  it('needs "before" for the before and after version', () => {
    expect(() => reportMarkdown(catalogue, externalRun(), 'before-after', at(60))).toThrow(/needs "before" recorded/u);
  });
});

describe('the before and after report (template B)', () => {
  function afterRun(): Run {
    let run = ok(recordBaseline(externalRun(), at(10)));
    run = catalogue.preChange.reduce((r, row) => ok(ackPreChange(catalogue, r, row.id, true, at(20))), run);
    run = mark(run, 'EXT-05', 'fixed', 'DMARC p=none with rua, dig output');
    run = mark(run, 'EXT-17', 'pass', 'curl: four answers, one host');
    for (const row of postChangePending(catalogue, run)) run = ok(ackPostChange(catalogue, run, row.id, true, at(30)));
    return ok(closeRun(catalogue, run, at(40)));
  }
  const text = reportMarkdown(catalogue, afterRun(), 'before-after', at(60));

  it('compares the counts per colour and the checks passed, of the same denominator', () => {
    expect(text).toContain('| | Before, 2026-11-04 | After, 2026-11-04 |');
    expect(text).toContain('| ▲ Fix now | 1 | 0 |');
    expect(text).toContain('| ● Good | 1 | 3 |');
    expect(text).toContain('| Checks passed | 1 of 43 applicable | 3 of 43 applicable |');
  });

  it('lists what changed state', () => {
    expect(text).toContain('- **EXT-05 SPF, DKIM, DMARC and MX.** Fails to Fixed. Evidence: DMARC p=none with rua, dig output');
    // EXT-17 was "Passed" before and after; only its evidence changed, so it is not a change of state.
    expect(text).not.toContain('**EXT-17 HTTPS and canonical host.** Passed to Passed');
    expect(text).toContain('## What remains');
  });

  it('ends with the change control record', () => {
    expect(text).toContain('Pre-change list:');
    expect(text).toContain('Acknowledged 2026-11-04 13:20 UTC.');
    expect(text).toContain('Run closed 2026-11-04 13:40 UTC.');
    expect(text).not.toContain('Payments');
  });
});
