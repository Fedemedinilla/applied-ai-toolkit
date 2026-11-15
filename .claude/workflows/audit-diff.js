export const meta = {
  name: 'audit-diff',
  description: 'Diff-scoped audit of the applied-ai-toolkit: two lenses per changed unit and one per dependent unit, adversarial verify, test-first fixes in git worktrees, integration with the full suite, short Spanish report',
  whenToUse: 'After npm run -s audit:scope -- --json > scope.json, with that JSON as args, to audit only the units a branch changed and the units that import them',
  phases: [
    { title: 'Find', detail: 'lenses A and B per changed unit, lens D per dependent unit' },
    { title: 'Verify', detail: 'high: three skeptics with distinct focuses, majority of votes cast; medium: one own-reproduction verifier; low: one batch verifier per finder' },
    { title: 'Fix', detail: 'one fixer per unit in its own git worktree under .claude/worktrees, test first' },
    { title: 'Integrate', detail: 'merge fix branches, full suite from a clean install' },
    { title: 'Report', detail: 'short report in Spanish' },
  ],
}

// Input: the JSON printed by `npm run -s audit:scope -- --json` (test/audit-scope/), passed as args.
// The agent count follows the diff: two finders per changed unit, one per dependent unit, and
// verifiers per finding. Fixers get their worktree from `git worktree add`, never from the
// workflow's own worktree option, which fails when the session folder is not a git repository.
// Structure and guards are checked offline by test/audit-scope/audit-diff-workflow.test.ts.

const parsed = typeof args === 'string' ? (() => { try { return JSON.parse(args) } catch { return null } })() : args
const valid = !!parsed && typeof parsed === 'object' && parsed.version === 1 && Array.isArray(parsed.units) &&
  typeof parsed.root === 'string' && typeof parsed.head === 'string' && typeof parsed.branch === 'string'
if (!valid) {
  return { error: 'args must be the JSON of npm run -s audit:scope -- --json (version 1, with root, head, branch and units)' }
}
const S = parsed
if (!S.units.length) {
  log('the diff touches no audit unit; nothing to audit')
  return { nothingToAudit: true, files: S.files, unmapped: S.unmapped }
}

const REPO = S.root
const HEAD = S.head
const BRANCH = S.branch
const TRAILERS = `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011hVJxvix65QWpncgmFyXRw`

const COMMON = `Repository ${REPO} (GitHub Fedemedinilla/applied-ai-toolkit), branch ${BRANCH} at ${HEAD}. Federico's public toolkit: TypeScript on Node 24 (type stripping, strict tsc with exactOptionalPropertyTypes/noUncheckedIndexedAccess/erasableSyntaxOnly), Python site-check (stdlib only), PHP wp-hardening, Vite apps, an Astro docs site in docs-site/ (own lockfile). Read the root README.md, CONTRIBUTING.md and the README of the unit you work on before anything else.
Repository rules: tests run offline with no API key and no network; library folders are self-contained (import-fences/repo.config.ts); docs pass slop-lint (node slop-lint/cli.ts --lang en --format markdown <file>; no em dashes, no rhetorical triads); exact dependency versions; actions pinned by full SHA; workflows pass agent-playbook/src/workflow-secrets.ts; fixtures fictional; never personal contact data.
This is a DIFF-SCOPED audit: the branch changed ${S.files.length} files since the merge base ${S.mergeBase} with ${S.base}${S.dirty ? ', some of them uncommitted' : ''}. See them with git -C ${REPO} diff ${S.mergeBase} -- <files> (that includes uncommitted work).`

const FINDINGS = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['bug', 'security', 'test-gap', 'docs-mismatch', 'improvement'] },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          file: { type: 'string' },
          line: { type: 'integer' },
          title: { type: 'string' },
          detail: { type: 'string' },
          evidence: { type: 'string', description: 'command you ran and its output, or exact lines read' },
          failure_scenario: { type: 'string' },
          proposed_fix: { type: 'string' },
        },
        required: ['kind', 'severity', 'file', 'line', 'title', 'detail', 'evidence', 'failure_scenario', 'proposed_fix'],
      },
    },
    covered: { type: 'string', description: 'what you actually read and ran, briefly' },
  },
  required: ['findings', 'covered'],
}
const VERDICT = {
  type: 'object',
  properties: { refuted: { type: 'boolean' }, reason: { type: 'string' }, evidence: { type: 'string' } },
  required: ['refuted', 'reason', 'evidence'],
}
const BATCH = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: { index: { type: 'integer' }, refuted: { type: 'boolean' }, reason: { type: 'string' } },
        required: ['index', 'refuted', 'reason'],
      },
    },
  },
  required: ['verdicts'],
}

const LENS_A = `Lens A, correctness: find real bugs by RUNNING the code. Start from the changed files and the code that calls them, then read the rest of the unit as needed. Write throwaway scripts under /tmp/claude-0/audit-diff-<unit>/ that call the public functions and CLIs with edge inputs (empty, huge, unicode, CRLF, BOM, negative, boundary values, concurrent calls, malformed files, wrong types at boundaries) and compare to what the README promises. Also look for logic errors, off-by-one, wrong error codes, races, resource leaks, determinism breaks. Run the unit's own tests too.`
const LENS_B = `Lens B, security, tests and truth, centred on the change: (1) security issues (injection, XSS, path traversal, SSRF, secrets in output, unsafe defaults, missing validation at a boundary, auth/tenant isolation, ReDoS); (2) tests of the changed code that do not prove what they claim (mentally mutate the code: would the test fail?), missing negative cases, tests that would pass for the wrong reason; (3) README or doc claims that the change made untrue (flags, defaults, exit codes, numbers, behaviours); (4) improvements with a concrete payoff, marked kind improvement.`
const LENS_D = `Lens D, dependent: this unit did not change, but it imports a unit that did. Check that it still works with the changed code: run its tests, call the imported functions the way this unit does with the inputs it passes, and look for changed signatures, defaults, error types, return shapes or behaviour it relies on. Report only breakage or risk caused by the change.`

const changedFilesOf = (u) => u.files.map((f) => `- ${f}`).join('\n') || '- (none)'
const becauseOf = (u) => {
  const d = (S.dependents || []).find((x) => x.unit === u.id)
  return d ? d.because.map((b) => `- ${b.importer}:${b.line} imports ${b.specifier} (${b.target}, in changed unit ${b.on})`).join('\n') : '- (none)'
}
const finderPrompt = (u, lens) => `${COMMON}
You audit ONE unit: "${u.id}" (${u.paths}). Context for this unit: ${u.context}
${u.reason === 'changed' ? `Changed files in this unit:\n${changedFilesOf(u)}` : `Imports that make this unit depend on the change:\n${becauseOf(u)}`}
${lens}
Do not modify the repository (temp files only under /tmp/claude-0/). Report only findings with concrete evidence: a command and its output, or the exact lines. No style nits. No speculation without evidence: if you could not confirm something, leave it out. Each finding with a precise file:line inside the repository. Return the structured result.`

// Changed units get lenses A and B; dependent units get lens D only.
const jobs = []
for (const u of S.units) {
  if (u.reason === 'changed') {
    jobs.push({ u, ln: 'A', lens: LENS_A })
    jobs.push({ u, ln: 'B', lens: LENS_B })
  } else {
    jobs.push({ u, ln: 'D', lens: LENS_D })
  }
}
log(`plan: ${jobs.length} finders over ${S.units.length} units (${S.units.filter((u) => u.reason === 'changed').length} changed, ${S.units.filter((u) => u.reason !== 'changed').length} dependent), verifiers per finding`)

const VERIFY_FOCUS = [
  'Focus: does the code really behave as claimed? Reproduce it by running code.',
  'Focus: can the failure scenario actually happen for a real user or caller of this tool, through its public entry, CLI, app or workflow? (For an improvement: is it worth doing, safe, no public API break, in proportion?)',
  'Focus: start from zero, ignore the evidence given, and build your own minimal reproduction. Only if your own reproduction shows the defect, refuted=false.',
]
const where = (f) => `${(f.file || '').split('/').pop()}:${f.line}`

// High: three verifiers with distinct focuses, confirmed by a majority of the votes cast.
// Medium: one verifier that builds its own reproduction.
const verifyOne = (f, unit) => {
  const n = f.severity === 'high' ? 3 : 1
  const focus = (i) => (n === 1 ? VERIFY_FOCUS[2] : VERIFY_FOCUS[i])
  return parallel(Array.from({ length: n }, (_, i) => () => agent(
    `${COMMON}
Adversarially verify a reported ${f.kind} in unit "${unit}". Try to REFUTE it. ${focus(i)} Temp files only under /tmp/claude-0/verify-diff/. If you cannot reproduce it, or it is already handled elsewhere, refuted=true. Default to refuted=true when uncertain. Do not modify the repository.
Finding (${f.severity}): ${f.title}
At: ${f.file}:${f.line}
Detail: ${f.detail}
Evidence given: ${f.evidence}
Scenario: ${f.failure_scenario}
Proposed fix: ${f.proposed_fix}`,
    { label: `verify:${unit}:${where(f)}:${i}`, phase: 'Verify', schema: VERDICT })))
    .then((vs) => {
      const votes = vs.filter(Boolean)
      const upheld = votes.filter((v) => !v.refuted).length
      return { ...f, unit, upheld, votes: votes.length, expected: n, notes: votes.map((v) => v.reason).join(' | '), confirmed: votes.length > 0 && upheld * 2 > votes.length }
    })
}

// Low: the low findings of one finder go to one verifier, which reproduces each in turn.
const verifyLowBatch = (list, unit, lensKey) => {
  if (!list.length) return Promise.resolve([])
  const body = list.map((f, i) => `#${i} [${f.kind}/${f.severity}] ${f.title}\nAt: ${f.file}:${f.line}\nDetail: ${f.detail}\nEvidence given: ${f.evidence}\nScenario: ${f.failure_scenario}\nProposed fix: ${f.proposed_fix}`).join('\n\n')
  return agent(`${COMMON}
Adversarially verify ${list.length} low-severity findings reported for unit "${unit}". For EACH one, try to REFUTE it: reproduce it yourself by running code (temp files under /tmp/claude-0/verify-diff-${unit}-${lensKey}/) or reading the exact lines, and check that it can happen for a real user (for an improvement: worth doing, safe, in proportion). If you cannot reproduce it, or it is already handled elsewhere, refuted=true. Default to refuted=true when uncertain. Return one verdict per finding with its #index. Do not modify the repository.

${body}`, { label: `verify:${unit}:${lensKey}:low`, phase: 'Verify', schema: BATCH })
    .then((r) => list.map((f, idx) => {
      const v = r === null ? undefined : (r.verdicts || []).find((x) => x.index === idx)
      return { ...f, unit, upheld: v && !v.refuted ? 1 : 0, votes: v ? 1 : 0, expected: 1, notes: v ? v.reason : '', confirmed: !!v && !v.refuted }
    }))
}
const verifyAll = (findings, unit, lensKey) => {
  const low = findings.filter((f) => f.severity === 'low')
  const rest = findings.filter((f) => f.severity !== 'low')
  return parallel([
    () => verifyLowBatch(low, unit, lensKey),
    ...rest.map((f) => () => verifyOne(f, unit)),
  ]).then((parts) => parts.filter(Boolean).flat())
}

phase('Find')
const found = await pipeline(
  jobs,
  (j) => agent(finderPrompt(j.u, j.lens), { label: `find:${j.u.id}:${j.ln}`, phase: 'Find', schema: FINDINGS }),
  (r, j) => r === null ? null : verifyAll(r.findings || [], j.u.id, j.ln)
    .then((vs) => ({ unit: j.u.id, lens: j.ln, covered: r.covered || '', results: vs, expected: (r.findings || []).length })),
)

const all = found.filter(Boolean)
const raw = all.flatMap((x) => x.results)
// Completeness guard: never fix from a partial verification. Every finder must have returned, and
// every finding must have all of its votes; otherwise stop so the run can be resumed.
const missingFinders = jobs.length - all.length
const shortVerdicts = all.reduce((n, x) => n + (x.expected - x.results.length), 0) + raw.filter((f) => f.votes < f.expected).reduce((n, f) => n + (f.expected - f.votes), 0)
if (missingFinders > 0 || shortVerdicts > 0) {
  log(`incomplete: ${missingFinders} finders and ${shortVerdicts} verifications missing; stopping before Fix`)
  return { incomplete: true, missingFinders, shortVerdicts, raw: raw.length, confirmedSoFar: raw.filter((f) => f.confirmed).length }
}
// Dedup confirmed findings across lenses: same file, line within 3, same kind.
const confirmed = []
for (const f of raw.filter((x) => x.confirmed)) {
  if (!confirmed.some((c) => c.file === f.file && c.kind === f.kind && Math.abs((c.line || 0) - (f.line || 0)) <= 3)) confirmed.push(f)
}
const counts = { units: S.units.length, finders: jobs.length, raw: raw.length, confirmed: confirmed.length }
log(`find: ${raw.length} findings, ${confirmed.length} confirmed after dedup`)

const listFindings = (list) => list.map((f, i) => `${i + 1}. [${f.unit}/${f.kind}/${f.severity}] ${f.title} at ${f.file}:${f.line}\n${f.detail}\nEvidence: ${f.evidence}\nScenario: ${f.failure_scenario}\nProposed fix: ${f.proposed_fix}\nVerifier notes: ${f.notes}`).join('\n\n')
const rejected = raw.filter((f) => !f.confirmed).map((f) => `- [${f.unit}/${f.kind}/${f.severity}] ${f.title} (${f.file}:${f.line}) upheld ${f.upheld}/${f.votes}`).join('\n') || '- (none)'
const coverage = all.map((x) => `- ${x.unit}/${x.lens}: ${String(x.covered).slice(0, 300)}`).join('\n')

const reportPrompt = (extra) => `${COMMON}
You write the final report of this diff-scoped audit. Do not modify the repository.
Units in scope:
${S.units.map((u) => `- ${u.id} (${u.reason}${u.reason === 'dependent' ? `, via ${becauseOf(u).split('\n')[0].slice(2)}` : ''})`).join('\n')}
Unmapped changed files: ${(S.unmapped || []).join(', ') || 'none'}
Coverage per finder:
${coverage}
Confirmed findings:
${listFindings(confirmed) || '(none)'}
Refuted findings:
${rejected}
${extra}
Check that every confirmed finding ended fixed, proposed or rejected with a reason (git log ${HEAD}..HEAD in ${REPO}), and name any unit whose finder only read and never ran code.
Return the report in castellano rioplatense with voseo, in Markdown, short and concrete, no em dashes: a table (unidad, motivo, confirmados, arreglados, propuestos, rechazados), the high and medium findings with ruta:línea and commit, what stayed uncovered, the verification lines, and next steps for Federico. Every claim about code carries ruta:línea; anything unverified is marked [SIN VERIFICAR].`

if (!confirmed.length) {
  phase('Report')
  const report = await agent(reportPrompt('No confirmed findings: nothing was fixed.'), { label: 'report', phase: 'Report' })
  return { counts, report }
}
if (S.dirty) {
  // Fixers branch from the committed head, which lacks the uncommitted work the finders read.
  log('the scope had uncommitted changes; stopping before Fix: commit them, rerun audit:scope and resume')
  return { counts, stoppedBeforeFix: 'the scope had uncommitted changes; commit them, rerun npm run -s audit:scope -- --json > scope.json and run again', confirmed: listFindings(confirmed), rejected }
}

phase('Fix')
const ROOT_KINDS = ['cross', 'extra']
const kindOf = {}
for (const u of S.units) kindOf[u.id] = u.kind
const byUnit = {}
for (const f of confirmed) {
  const key = ROOT_KINDS.includes(kindOf[f.unit]) ? 'root' : f.unit
  ;(byUnit[key] = byUnit[key] || []).push(f)
}
const fixUnits = Object.keys(byUnit)
const fixPrompt = (key, list) => `${COMMON}
You fix confirmed audit findings for ${key === 'root' ? 'the repository root and cross-cutting files (workflows, actions, packaging, root docs, dependencies, repository tooling)' : `unit "${key}"`}. Work in your own git worktree, never in the main checkout ${REPO}. Create it first: WT=${REPO}/.claude/worktrees/audit-diff-${key}; if it does not exist, git -C ${REPO} worktree add "$WT" -b audit-diff/fix-${key} ${HEAD} (if the branch already exists, git -C ${REPO} worktree add "$WT" audit-diff/fix-${key} and continue from its commits). cd "$WT" in every shell command. Then npm ci (and npm --prefix docs-site ci only if you touch docs-site). For PHP tests do not run composer install: ln -s ${REPO}/wp-hardening/vendor "$WT/wp-hardening/vendor" (never commit it). Disk is limited: when you finish, rm -rf "$WT/node_modules" "$WT/docs-site/node_modules" and the vendor link, keep the worktree and branch.
For each finding: if testable, first write a test that fails and reproduces it (run it, see it fail), then the minimal fix, then the test passes. For an improvement: apply it only if it is small and keeps every public behaviour; otherwise do not change code and describe the proposal in your report. If, after reading the code, a finding is wrong, change nothing for it and say why. Never weaken, skip or delete an existing test. Keep public entries backward compatible.
${key === 'root' ? 'You own root files, .github/, */action.yml, test/, package.json, package-lock.json, .changeset/, docs-site config. Do not edit unit sources except action.yml files.' : `Edit only files under this unit${key.startsWith('apps-') ? ' (and its csp-guard/vite config)' : ''}. Do NOT edit the root README.md, root package.json, lockfiles or other folders: if a fix needs that, describe it in your report for the integrator. You may update this unit's README and add a changeset under .changeset/ if the unit is one of the four npm packages and its behaviour changes (patch).`}
Commit one finding (or tightly related group) per commit: English imperative subject, body with the why and the verification command with its result, ending exactly with:
${TRAILERS}
Before finishing run npm run check, the unit's tests, the import fences, and slop-lint on any doc you changed (and npm run test:python / test:php / build:docs / pack:check when relevant).
Findings:
${listFindings(list)}
Return a SHORT report: branch name, worktree path, per finding fixed/proposed/rejected with commit sha and one line why, verification lines, and anything the integrator must do in root files.`
const fixes = await parallel(fixUnits.map((k) => () =>
  agent(fixPrompt(k, byUnit[k]), { label: `fix:${k}`, phase: 'Fix' }).then((r) => (r === null ? null : { key: k, report: r }))))
const fixReports = fixes.filter(Boolean)
if (fixReports.length < fixUnits.length) {
  const done = fixReports.map((f) => f.key)
  const missing = fixUnits.filter((k) => !done.includes(k))
  log(`incomplete: fixers missing for ${missing.join(', ')}; stopping before Integrate`)
  return { incomplete: true, stage: 'Fix', missing, counts }
}

phase('Integrate')
const integration = await agent(`${COMMON}
Integrate the audit-diff fixes. Work in the main checkout ${REPO} on ${BRANCH}. First check that git rev-parse HEAD is ${HEAD} and git status --porcelain is empty; if not, change nothing and report why. Fixer reports:
${fixReports.map((f) => `--- ${f.key} ---\n${f.report}`).join('\n')}
1. Merge each fixer branch audit-diff/fix-<unit> with git merge --no-ff (message "Merge audit-diff fixes for <unit>" with a one-line body and the two trailer lines below). Resolve conflicts keeping both intents.
2. Apply every root change the fixers asked the integrator for, each as its own commit, only after checking it is right.
3. From a clean install (rm -rf node_modules && npm ci): npm run check; npx vitest run; node import-fences/cli.ts --config import-fences/repo.config.ts; npm run lint:docs; npm run pack:check; npm run test:python; npm run test:php; npm run build:apps && npm run guard:apps; npm run build:docs. Fix anything red at its root cause (test first).
4. Remove the fixer worktrees and their branches once merged (git worktree remove, git branch -D; check each is an ancestor of HEAD first). Do not push.
Commit trailer lines, exactly:
${TRAILERS}
Return a SHORT report: merged branches, extra commits, every verification command with its result line, anything still red.`, { label: 'integrate', phase: 'Integrate' })
if (integration === null) return { incomplete: true, stage: 'Integrate', counts }

phase('Report')
const report = await agent(reportPrompt(`Fixer reports:
${fixReports.map((f) => `--- ${f.key} ---\n${String(f.report).slice(0, 2500)}`).join('\n')}
Integration report:
${integration}`), { label: 'report', phase: 'Report' })

return { counts, report, integration }
