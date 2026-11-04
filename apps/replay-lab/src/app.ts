// The page: a play tab (seed, actions, state, log, run file), a batch tab (1,000 runs in a Web
// Worker, a histogram) and an explanation. Every number on screen comes from the core; the page
// formats it and never computes a rule itself.

import {
  canApply,
  heatPermille,
  InvalidInputError,
  MAX_SEED_LENGTH,
  rollSum,
  rulesFor,
  type BatchReport,
  type ComboName,
  type Distribution,
  type Input,
  type LogEntry,
  type Ruleset,
  type State,
} from '../../../deterministic-sim/src/index.ts';
import { checkRequest, MAX_RUNS, type BatchMessage, type BatchRequest } from './batch-protocol.ts';
import { byId, h } from './dom.ts';
import { bins, histogramSvg } from './histogram.ts';
import { exportRun, importRun, MAX_FILE_BYTES, tooLarge } from './run-file.ts';
import { apply, fromReplay, hashesOf, newSession, undo, type Session } from './session.ts';

export interface BatchRunner {
  /** Starts a batch and returns a function that cancels it. */
  start(request: BatchRequest, onMessage: (message: BatchMessage) => void): () => void;
}

export interface Deps {
  readonly batch: BatchRunner;
  /** A URL for a downloadable file (URL.createObjectURL in the browser). */
  objectUrl(text: string, type: string): string;
  revokeUrl(url: string): void;
  randomSeed(): string;
  /** Milliseconds, for the elapsed time of a batch. Never read by the core. */
  now(): number;
}

export interface App {
  session(): Session | null;
}

const short = (hash: string): string => hash.slice(0, 16);
const permille = (p: number): string => `x${(p / 1000).toFixed(p % 100 === 0 ? 1 : 2)}`;
const mean = (d: Distribution): string => (d.mean100 / 100).toFixed(2);

function houseMultiplier(rules: Ruleset, name: string): number {
  const house = rules.houses.find((h) => h.name === name);
  if (!house) throw new Error(`no house ${name}`);
  return house.permille;
}

const COMBO_LABELS: Readonly<Record<ComboName, string>> = {
  single: 'Single die',
  none: 'No match',
  pair: 'Pair',
  'two-pair': 'Two pairs',
  triple: 'Three of a kind',
  'full-house': 'Full house',
  four: 'Four of a kind',
  five: 'Five of a kind',
};

export function describeEntry(entry: LogEntry, rounds: number): string {
  const head = `Round ${entry.round} of ${rounds}`;
  let text: string;
  if (entry.outcome === 'rested') text = `${head}: rested. Chips ${entry.chips}.`;
  else if (entry.outcome === 'bust') text = `${head}: rolled ${entry.dice.join(', ')}. Bust: no points, streak reset.`;
  else {
    const combo = entry.combo ? COMBO_LABELS[entry.combo] : 'Scored';
    text = `${head}: rolled ${entry.dice.join(', ')}. ${combo}, ${entry.points} ${entry.points === 1 ? 'point' : 'points'}.`;
  }
  if (entry.endBonus > 0) text += ` ${entry.endBonus} more for chips left.`;
  return text;
}

function formula(entry: LogEntry): string {
  if (entry.outcome !== 'scored') return '';
  return `${rollSum(entry.dice)} ${entry.multipliers.map(permille).join(' ')} = ${entry.points}`;
}

export function mountApp(doc: Document, deps: Deps): App {
  let session: Session | null = null;
  let downloadUrl: string | null = null;
  let cancelBatch: (() => void) | null = null;

  const seedForm = byId<HTMLFormElement>(doc, 'seed-form');
  const seedInput = byId<HTMLInputElement>(doc, 'seed');
  const play = byId(doc, 'play');
  const status = byId(doc, 'status');
  const actions = byId(doc, 'actions');
  const rollButtons = [...actions.querySelectorAll<HTMLButtonElement>('button[data-dice]')];
  const restButton = byId<HTMLButtonElement>(doc, 'rest');
  const undoButton = byId<HTMLButtonElement>(doc, 'undo');
  const lastRoll = byId(doc, 'last-roll');
  const log = byId<HTMLOListElement>(doc, 'log');
  const exportButton = byId<HTMLButtonElement>(doc, 'export');
  const download = byId<HTMLAnchorElement>(doc, 'download');
  const importInput = byId<HTMLInputElement>(doc, 'import-file');
  const importResult = byId(doc, 'import-result');
  seedInput.maxLength = MAX_SEED_LENGTH;

  // ---- play ----

  const setText = (id: string, text: string): void => {
    byId(doc, id).textContent = text;
  };

  function clearDownload(): void {
    if (downloadUrl) deps.revokeUrl(downloadUrl);
    downloadUrl = null;
    download.hidden = true;
    download.removeAttribute('href');
  }

  function renderState(state: State): void {
    // The ruleset the state names, not the newest one: an imported run may be older.
    const rules = rulesFor(state.rulesetVersion);
    setText('st-round', `${state.round} of ${rules.rounds}`);
    setText('st-chips', `${state.chips} of ${rules.maxChips}`);
    setText('st-score', String(state.score));
    setText('st-streak', `${state.streak} (next roll ${permille(heatPermille(rules, state.streak))})`);
    setText('st-house', state.status === 'ended' ? 'none, the tournament is over' : `${state.house} (${permille(houseMultiplier(rules, state.house))})`);
    setText('st-busts', String(state.busts));
    setText('st-seed', state.seed);
    const { inputs, state: stateHashText } = hashesOf(state);
    setText('hash-inputs', short(inputs));
    setText('hash-state', short(stateHashText));
    byId(doc, 'hash-inputs').title = inputs;
    byId(doc, 'hash-state').title = stateHashText;
  }

  function renderActions(state: State): void {
    for (const button of rollButtons) button.disabled = !canApply(state, { kind: 'roll', dice: Number(button.dataset['dice']) });
    restButton.disabled = state.status !== 'active';
    undoButton.disabled = state.round === 0;
  }

  function renderLast(state: State): void {
    lastRoll.replaceChildren();
    const entry = state.log[state.log.length - 1];
    if (!entry) {
      lastRoll.append(h(doc, 'p', { class: 'hint' }, 'No round played yet.'));
      return;
    }
    if (entry.dice.length > 0) {
      lastRoll.append(
        h(doc, 'ul', { class: 'dice', 'aria-label': `Dice: ${entry.dice.join(', ')}` }, ...entry.dice.map((face) => h(doc, 'li', { class: face === 1 ? 'die one' : 'die' }, face))),
      );
    }
    lastRoll.append(h(doc, 'p', {}, describeEntry(entry, rulesFor(state.rulesetVersion).rounds)));
    const f = formula(entry);
    if (f) lastRoll.append(h(doc, 'p', { class: 'formula' }, `sum x combo x streak x house, floored once: ${f}`));
  }

  function renderLog(state: State): void {
    log.replaceChildren(
      ...state.log
        .slice()
        .reverse()
        .map((entry) =>
          h(
            doc,
            'li',
            { value: String(entry.round), class: `entry ${entry.outcome}` },
            h(doc, 'span', { class: 'what' }, describeEntry(entry, rulesFor(state.rulesetVersion).rounds)),
            formula(entry) ? h(doc, 'span', { class: 'formula' }, formula(entry)) : null,
          ),
        ),
    );
  }

  function render(next: Session): void {
    session = next;
    play.hidden = false;
    clearDownload();
    renderState(next.state);
    renderActions(next.state);
    renderLast(next.state);
    renderLog(next.state);
  }

  function startRun(seed: string): void {
    const trimmed = seed.trim();
    if (trimmed.length === 0) {
      status.textContent = 'Type a seed, or press Random seed.';
      seedInput.focus();
      return;
    }
    const fresh = newSession(trimmed);
    render(fresh);
    status.textContent = `New run with seed "${trimmed}". The first house mood is ${fresh.state.house}.`;
  }

  function act(input: Input): void {
    if (!session) return;
    try {
      const next = apply(session, input);
      render(next);
      const entry = next.state.log[next.state.log.length - 1];
      let text = entry ? describeEntry(entry, rulesFor(next.state.rulesetVersion).rounds) : '';
      if (next.state.status === 'ended') text += ` The tournament is over. Final score ${next.state.score}.`;
      status.textContent = text;
      if (next.state.status === 'ended') exportButton.focus();
    } catch (error) {
      status.textContent = error instanceof InvalidInputError ? `Not allowed: ${error.message}.` : 'That input could not be applied.';
    }
  }

  seedForm.addEventListener('submit', (event) => {
    event.preventDefault();
    startRun(seedInput.value);
  });
  byId(doc, 'random-seed').addEventListener('click', () => {
    seedInput.value = deps.randomSeed();
    startRun(seedInput.value);
  });
  for (const button of rollButtons) button.addEventListener('click', () => act({ kind: 'roll', dice: Number(button.dataset['dice']) }));
  restButton.addEventListener('click', () => act({ kind: 'rest' }));
  undoButton.addEventListener('click', () => {
    if (!session || session.inputs.length === 0) return;
    render(undo(session));
    status.textContent = `Undone. Replayed ${session.inputs.length} ${session.inputs.length === 1 ? 'input' : 'inputs'} from the seed: round ${session.state.round}, score ${session.state.score}.`;
  });

  // Keys 1 to 5 roll, R rests, U undoes, anywhere in the play panel (Start keeps focus after a new
  // run) while focus is not in a text field.
  byId(doc, 'panel-play').addEventListener('keydown', (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA')) return;
    const key = event.key.toLowerCase();
    const button = /^[1-5]$/u.test(key) ? rollButtons[Number(key) - 1] : key === 'r' ? restButton : key === 'u' ? undoButton : undefined;
    if (session && button && !button.disabled) {
      event.preventDefault();
      button.click();
    }
  });

  exportButton.addEventListener('click', () => {
    if (!session) return;
    const file = exportRun(session.state);
    clearDownload();
    downloadUrl = deps.objectUrl(file.text, 'application/json');
    download.href = downloadUrl;
    download.download = file.fileName;
    download.textContent = `Download ${file.fileName}`;
    download.hidden = false;
    download.focus();
    status.textContent = `Run file ready: ${file.fileName}, ${session.inputs.length} ${session.inputs.length === 1 ? 'input' : 'inputs'}.`;
  });

  importInput.addEventListener('change', () => {
    const file = importInput.files?.[0];
    if (!file) return;
    // Refused before the file is read, so a huge file never reaches memory. importRun checks again
    // for direct callers.
    if (file.size > MAX_FILE_BYTES) {
      importInput.value = '';
      importResult.replaceChildren(h(doc, 'p', { class: 'bad' }, `${file.name} could not be replayed: ${tooLarge(file.size)}.`));
      return;
    }
    importResult.replaceChildren(h(doc, 'p', {}, `Replaying ${file.name}...`));
    file.text().then(
      (text) => {
        const v = importRun(text, file.size);
        importInput.value = '';
        if (!v.ok) {
          importResult.replaceChildren(h(doc, 'p', { class: 'bad' }, `${file.name} could not be replayed: ${v.error}.`));
          return;
        }
        const line = (label: string, matches: boolean | null, hash: string): HTMLElement =>
          h(
            doc,
            'li',
            { class: matches === false ? 'bad' : matches ? 'good' : '' },
            `${label}: `,
            matches === null ? 'the file states none; ' : matches ? 'matches ' : 'does not match; the file says otherwise. Recomputed ',
            h(doc, 'code', { title: hash }, short(hash)),
          );
        importResult.replaceChildren(
          h(doc, 'p', {}, `${file.name}: seed "${v.record.seed}", ${v.record.inputs.length} ${v.record.inputs.length === 1 ? 'input' : 'inputs'}, ruleset ${v.record.rulesetVersion}. Replayed to round ${v.state.round}, score ${v.state.score}.`),
          h(doc, 'ul', { class: 'checks' }, line('Inputs hash', v.inputsHashMatches, v.inputsHash), line('Final state hash', v.finalStateHashMatches, v.finalStateHash)),
        );
        seedInput.value = v.record.seed;
        render(fromReplay(v.record, v.state));
      },
      () => {
        importResult.replaceChildren(h(doc, 'p', { class: 'bad' }, `${file.name} could not be read.`));
      },
    );
  });

  // ---- batch ----

  const batchForm = byId<HTMLFormElement>(doc, 'batch-form');
  const runsInput = byId<HTMLInputElement>(doc, 'runs');
  const diceSelect = byId<HTMLSelectElement>(doc, 'dice');
  const prefixInput = byId<HTMLInputElement>(doc, 'prefix');
  const runButton = byId<HTMLButtonElement>(doc, 'run-batch');
  const cancelButton = byId<HTMLButtonElement>(doc, 'cancel-batch');
  const progress = byId<HTMLProgressElement>(doc, 'batch-progress');
  const batchStatus = byId(doc, 'batch-status');
  const result = byId(doc, 'batch-result');
  runsInput.max = String(MAX_RUNS);

  function finishBatch(): void {
    cancelBatch = null;
    runButton.disabled = false;
    cancelButton.hidden = true;
    progress.hidden = true;
  }

  function renderReport(report: BatchReport, hash: string, ms: number): void {
    const row = (label: string, d: Distribution): HTMLTableRowElement =>
      h(doc, 'tr', {}, h(doc, 'th', { scope: 'row' }, label), ...[d.min, d.p10, d.p50, d.p90, d.max].map((v) => h(doc, 'td', {}, v)), h(doc, 'td', {}, mean(d)));
    const table = h(
      doc,
      'table',
      { class: 'summary' },
      h(doc, 'caption', {}, `${report.runs.toLocaleString('en-US')} runs, policy ${report.policy}, ruleset ${report.rulesetVersion}, seeds ${report.seedPrefix}-0 to ${report.seedPrefix}-${report.runs - 1}`),
      h(doc, 'thead', {}, h(doc, 'tr', {}, ...['', 'min', 'p10', 'p50', 'p90', 'max', 'mean'].map((t) => h(doc, 'th', { scope: 'col' }, t)))),
      h(doc, 'tbody', {}, row('Score', report.score), row('Busts', report.busts), row('Chips left', report.chipsLeft)),
    );
    const binsTable = h(
      doc,
      'table',
      { class: 'bins' },
      h(doc, 'thead', {}, h(doc, 'tr', {}, h(doc, 'th', { scope: 'col' }, 'Score'), h(doc, 'th', { scope: 'col' }, 'Runs'))),
      h(doc, 'tbody', {}, ...bins(report.score.histogram).map((b) => h(doc, 'tr', {}, h(doc, 'td', {}, `${b.from} to ${b.to}`), h(doc, 'td', {}, b.count)))),
    );
    result.replaceChildren(
      table,
      h(doc, 'figure', {}, histogramSvg(doc, report.score.histogram, `Final score, ${report.runs.toLocaleString('en-US')} runs`, 'score-histogram'), h(doc, 'figcaption', {}, 'Final score per run, in bins of 20 points.')),
      h(doc, 'details', {}, h(doc, 'summary', {}, 'The histogram as a table'), binsTable),
      h(doc, 'p', { class: 'hash-line' }, 'Report hash ', h(doc, 'code', { title: hash }, short(hash)), `. The same runs, dice and prefix give the same hash on any machine. Took ${Math.round(ms)} ms.`),
    );
  }

  batchForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (cancelBatch) return;
    const request = checkRequest({ runs: Number(runsInput.value), dice: Number(diceSelect.value), seedPrefix: prefixInput.value.trim() });
    if (typeof request === 'string') {
      batchStatus.textContent = `Not started: ${request}.`;
      return;
    }
    const started = deps.now();
    runButton.disabled = true;
    cancelButton.hidden = false;
    progress.hidden = false;
    progress.max = request.runs;
    progress.value = 0;
    batchStatus.textContent = `Running ${request.runs.toLocaleString('en-US')} runs in a worker...`;
    let announcedQuarter = 0;
    cancelBatch = deps.batch.start(request, (message) => {
      if (message.type === 'progress') {
        progress.value = message.done;
        // The status line changes once per quarter, so a screen reader is not read every update.
        const quarter = Math.floor((message.done * 4) / message.total);
        if (quarter > announcedQuarter) {
          announcedQuarter = quarter;
          batchStatus.textContent = `${message.done.toLocaleString('en-US')} of ${message.total.toLocaleString('en-US')} runs played.`;
        }
        return;
      }
      finishBatch();
      if (message.type === 'error') {
        batchStatus.textContent = `The batch failed: ${message.message}.`;
        return;
      }
      const ms = deps.now() - started;
      renderReport(message.report, message.hash, ms);
      batchStatus.textContent = `Done: ${message.report.runs.toLocaleString('en-US')} runs, mean score ${mean(message.report.score)}, median ${message.report.score.p50}.`;
    });
  });

  cancelButton.addEventListener('click', () => {
    if (!cancelBatch) return;
    cancelBatch();
    finishBatch();
    batchStatus.textContent = 'Cancelled. No report.';
    runButton.focus();
  });

  // ---- tabs ----

  const tabs = [...doc.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  function select(tab: HTMLButtonElement, focus: boolean): void {
    for (const t of tabs) {
      const selected = t === tab;
      t.setAttribute('aria-selected', String(selected));
      t.tabIndex = selected ? 0 : -1;
      const panel = byId(doc, t.getAttribute('aria-controls') ?? '');
      panel.hidden = !selected;
    }
    if (focus) tab.focus();
  }
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => select(tab, false));
    tab.addEventListener('keydown', (event) => {
      const last = tabs.length - 1;
      const target = event.key === 'ArrowRight' ? (i === last ? 0 : i + 1) : event.key === 'ArrowLeft' ? (i === 0 ? last : i - 1) : event.key === 'Home' ? 0 : event.key === 'End' ? last : -1;
      const next = tabs[target];
      if (!next) return;
      event.preventDefault();
      select(next, true);
    });
  });

  return { session: () => session };
}
