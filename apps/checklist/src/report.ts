// The Markdown exports: the status report (a check, or before and after) and the incident timeline.
// Every string a person typed goes through md() before it is written, so an evidence note cannot add
// a heading, a link, a table cell or raw HTML to the report.

import type { Catalogue, Item } from './catalogue.ts';
import { COLOUR_INFO, COLOURS, deriveColour, summarise, countLine, type Colour, type Summary } from './colours.ts';
import { formatElapsed, formatUtc, timeline } from './incident.ts';
import { applies, matrixApplies, STATE_LABELS, type Run, type State } from './run.ts';

/** One line of inline Markdown from free text: whitespace collapsed, syntax characters escaped. */
export function md(text: string): string {
  return text
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[\\`*_[\]<>|]/gu, (c) => `\\${c}`);
}

export type ReportKind = 'check' | 'before-after';

const day = (iso: string): string => iso.slice(0, 10);

function siteTitle(run: Run): string {
  return md(run.site.name || run.site.url || 'Unnamed site');
}

function scopeText(run: Run, kind: ReportKind): string {
  if (kind === 'before-after' && run.baseline) {
    return `Measured before (${day(run.baseline.at)}) and after (the date above) with the same checklist and the same site profile. Each change was made after the pre-change list and checked with the post-change matrix (listed at the end).`;
  }
  if (!run.profile.authorized) {
    return 'Only what any visitor can see from outside was checked: how the site answers, how it loads on a phone, how the domain and its mail are set up, and whether it is on lists of dangerous sites. The dashboard and the hosting were not opened, so users, backups and installed components are not in this report.';
  }
  return 'The work was done inside the site under a written authorization, as well as from outside.';
}

function summaryLines(summary: Summary): string[] {
  const lines = COLOURS.map((c) => `- ${COLOUR_INFO[c].shape} ${COLOUR_INFO[c].label}: ${countLine(c, summary)}`);
  const greyParts: string[] = [];
  if (summary.unmarked) greyParts.push(`${summary.unmarked} not marked yet`);
  if (summary.noEvidence) greyParts.push(`${summary.noEvidence} passed without an evidence note`);
  if (greyParts.length) lines.push(`- Of the ones not checked: ${greyParts.join(', ')}.`);
  if (summary.notApplicable) lines.push(`- ${summary.notApplicable} not applicable to this site, left out of the ${summary.applicable}.`);
  return lines;
}

interface Row {
  readonly item: Item;
  readonly state: State | null;
  readonly evidence: string;
  readonly colour: Colour | null;
  readonly note: string | null;
  readonly grey: string | null;
}

function rows(catalogue: Catalogue, run: Run): Row[] {
  return catalogue.items
    .filter((item) => applies(item, run.profile))
    .map((item) => {
      const mark = run.marks[item.id];
      const d = deriveColour(item, mark?.state ?? null, mark?.evidence ?? '');
      return { item, state: mark?.state ?? null, evidence: mark?.evidence ?? '', colour: d.colour, note: d.note, grey: d.grey };
    });
}

const head = (r: Row): string => `**${r.item.id} ${md(r.item.title)}.**`;
const evidence = (r: Row): string => (r.evidence.trim() ? ` Evidence: ${md(r.evidence)}` : '');

function attentionLine(r: Row): string {
  const note = r.note ? ` (${md(r.note)})` : '';
  return `- ${head(r)} ${md(r.item.question)} State: ${STATE_LABELS[r.state ?? 'not_verified']}${note}.${evidence(r)} What to do: ${md(r.item.ifFails)}`;
}

function greyLine(r: Row): string {
  const why = r.grey === 'not_marked' ? 'not marked in this run' : r.grey === 'no_evidence' ? `marked ${STATE_LABELS[r.state ?? 'pass']} with no evidence note` : 'not verified';
  return `- ${head(r)} ${md(r.item.question)} Why: ${why}.${evidence(r)}`;
}

export function reportMarkdown(catalogue: Catalogue, run: Run, kind: ReportKind, now: Date): string {
  if (kind === 'before-after' && !run.baseline) throw new Error('a before and after report needs "before" recorded');
  const out: string[] = [];
  const all = rows(catalogue, run);
  const after = summarise(catalogue, run);

  out.push(`# Site status: ${siteTitle(run)}`, '');
  out.push(`Site: ${md(run.site.url || 'no address given')}. Date: ${day(now.toISOString())}. Catalogue ${catalogue.id}.`, '');
  out.push('## What was checked and what was not', '', scopeText(run, kind), '');

  out.push('## Summary', '', ...summaryLines(after), '');

  if (kind === 'before-after' && run.baseline) {
    const before = summarise(catalogue, run, null, run.baseline);
    out.push('## Before and after', '');
    out.push(`| | Before, ${day(run.baseline.at)} | After, ${day(now.toISOString())} |`, '|---|---|---|');
    for (const c of COLOURS) out.push(`| ${COLOUR_INFO[c].shape} ${COLOUR_INFO[c].label} | ${before.colours[c]} | ${after.colours[c]} |`);
    out.push(`| Checks passed | ${before.passed} of ${before.applicable} applicable | ${after.passed} of ${after.applicable} applicable |`, '');

    const changed = all.filter((r) => (run.baseline?.states[r.item.id] ?? null) !== r.state);
    out.push('## What changed', '');
    if (changed.length === 0) out.push('No check changed state.');
    for (const r of changed) {
      const was = run.baseline.states[r.item.id];
      out.push(`- ${head(r)} ${was ? STATE_LABELS[was] : 'Not marked'} to ${r.state ? STATE_LABELS[r.state] : 'Not marked'}.${evidence(r)}`);
    }
    out.push('');
  }

  out.push(kind === 'before-after' ? '## What remains' : '## Needs attention', '');
  let any = false;
  for (const c of ['red', 'yellow', 'blue'] as const) {
    const group = all.filter((r) => r.colour === c);
    if (!group.length) continue;
    any = true;
    out.push(`### ${COLOUR_INFO[c].shape} ${COLOUR_INFO[c].label} (${group.length})`, '', ...group.map(attentionLine), '');
  }
  if (!any) out.push('Nothing marked red, yellow or blue.', '');

  const green = all.filter((r) => r.colour === 'green');
  out.push(`## ${COLOUR_INFO.green.shape} What is good (${green.length})`, '');
  out.push(...(green.length ? green.map((r) => `- ${head(r)} ${md(r.item.question)}${evidence(r)}`) : ['Nothing marked good yet.']), '');

  const grey = all.filter((r) => r.colour === 'grey');
  out.push(`## ${COLOUR_INFO.grey.shape} Could not check (${grey.length})`, '');
  out.push(...(grey.length ? grey.map(greyLine) : ['Every applicable check was marked.']), '');

  const na = all.filter((r) => r.colour === null);
  if (na.length) out.push(`## Not applicable (${na.length})`, '', ...na.map((r) => `- ${head(r)}${evidence(r) || ' No reason written.'}`), '');

  if (!run.profile.authorized) {
    out.push('## What cannot be seen from outside', '', '- Users and dashboard accounts.', '- Backups, and whether they restore.', '- Installed components and their versions.', '- Files and the database.', '');
  }

  out.push('## How it was checked', '');
  out.push('Each check is in one of seven states. A pass without an evidence note counts as not checked, never as good. Colours come from a fixed table of state, priority and area.');
  for (const imp of run.imports) out.push(`- site-check run of ${md(imp.domain)} on ${md(imp.runDate)}: ${imp.applied} checks pre-filled, ${imp.kept} already marked and kept.`);
  out.push('');

  if (kind === 'before-after') {
    out.push('## Change control', '');
    const pre = catalogue.preChange.map((r) => `- ${md(r.text)} ${run.preChange[r.id] ? `Acknowledged ${formatUtc(run.preChange[r.id] ?? '')}.` : 'Not acknowledged.'}`);
    out.push('Pre-change list:', '', ...pre, '');
    const post = catalogue.postChange
      .filter((r) => matrixApplies(r, run.profile))
      .map((r) => `- ${md(r.what)}: ${md(r.pass)}. ${run.postChange[r.id] ? `Acknowledged ${formatUtc(run.postChange[r.id] ?? '')}.` : 'Not acknowledged.'}`);
    out.push('Post-change matrix:', '', ...post, '');
    out.push(run.closedAt ? `Run closed ${formatUtc(run.closedAt)}.` : 'The run is still open.', '');
  }
  return `${out.join('\n').replace(/\n{3,}/gu, '\n\n').trimEnd()}\n`;
}

export function incidentMarkdown(catalogue: Catalogue, run: Run): string {
  const entries = timeline(catalogue, run.incident);
  const out = [`# Incident timeline: ${siteTitle(run)}`, ''];
  if (!entries.length) return `${out.join('\n')}No step ticked yet.\n`;
  out.push(`Times are UTC. The first step was ticked ${formatUtc(entries[0]?.at ?? '')}.`, '');
  out.push('| Time | Elapsed | Phase | Step | Note |', '|---|---|---|---|---|');
  for (const e of entries) {
    out.push(`| ${formatUtc(e.at)} | ${formatElapsed(e.elapsed)} | ${e.step.phase}. ${md(e.phaseName)} | ${md(e.step.text)} | ${md(e.note) || ' '} |`);
  }
  const open = catalogue.incident.steps.filter((s) => run.incident[s.id] === undefined);
  out.push('', `## Not done (${open.length} of ${catalogue.incident.steps.length})`, '');
  out.push(...(open.length ? open.map((s) => `- ${s.phase}. ${md(s.text)}`) : ['Every step is done.']));
  return `${out.join('\n')}\n`;
}
