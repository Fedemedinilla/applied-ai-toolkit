// @vitest-environment jsdom
//
// The page in a DOM, against the real index.html: start a seed, play, undo, export a run file,
// import it back and see both hashes match, edit it and see one fail, and run a batch through a
// runner that calls the worker's job in this process.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { replay, stateHash } from '../../../deterministic-sim/src/index.ts';
import { mountApp, type App, type BatchRunner } from '../src/app.ts';
import { runBatchJob, type BatchMessage } from '../src/batch-protocol.ts';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '../index.html'), 'utf8');

interface Harness {
  app: App;
  urls: Map<string, string>;
  revoked: string[];
  batches: number;
}

function mount(batch?: BatchRunner): Harness {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  document.body.replaceWith(document.importNode(parsed.body, true));
  const urls = new Map<string, string>();
  const revoked: string[] = [];
  let clock = 0;
  const harness: Harness = { app: undefined as never, urls, revoked, batches: 0 };
  const runner: BatchRunner = batch ?? {
    start(request, onMessage) {
      harness.batches += 1;
      runBatchJob(request, onMessage);
      return () => undefined;
    },
  };
  harness.app = mountApp(document, {
    batch: runner,
    objectUrl: (text) => {
      const url = `blob:test/${urls.size + 1}`;
      urls.set(url, text);
      return url;
    },
    revokeUrl: (url) => revoked.push(url),
    randomSeed: () => 'random-7',
    now: () => (clock += 125),
  });
  return harness;
}

const $ = <T extends Element = HTMLElement>(selector: string): T => {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`missing ${selector}`);
  return el;
};
const text = (selector: string): string => $(selector).textContent ?? '';
const click = (selector: string): void => $<HTMLButtonElement>(selector).click();

function startSeed(seed: string): void {
  $<HTMLInputElement>('#seed').value = seed;
  $<HTMLFormElement>('#seed-form').requestSubmit();
}

function chooseFile(name: string, content: string): void {
  const input = $<HTMLInputElement>('#import-file');
  const file = new File([content], name, { type: 'application/json' });
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  input.dispatchEvent(new Event('change'));
}

describe('play', () => {
  it('starts a run from the seed and shows the state the core computed', () => {
    const { app } = mount();
    expect($('#play').hidden).toBe(true);
    startSeed('lab-1');
    expect($('#play').hidden).toBe(false);
    const state = app.session()?.state;
    expect(state).toEqual(replay('lab-1', []));
    expect(text('#st-round')).toBe('0 of 20');
    expect(text('#st-chips')).toBe('10 of 20');
    expect(text('#status')).toContain('New run with seed "lab-1"');
    expect(text('#hash-state')).toBe(stateHash(replay('lab-1', [])).slice(0, 16));
  });

  it('refuses an empty seed with a message and focus on the field', () => {
    mount();
    startSeed('   ');
    expect($('#play').hidden).toBe(true);
    expect(text('#status')).toBe('Type a seed, or press Random seed.');
    expect(document.activeElement?.id).toBe('seed');
  });

  it('a roll updates chips, log and the live status; the same clicks on the same seed give the same game', () => {
    const { app } = mount();
    startSeed('lab-1');
    click('[data-dice="3"]');
    click('[data-dice="2"]');
    expect(text('#st-chips')).toBe('5 of 20');
    expect(text('#st-round')).toBe('2 of 20');
    expect($('#log').children).toHaveLength(2);
    expect(text('#status')).toMatch(/^Round 2 of 20: rolled \d, \d\./u);
    expect(app.session()?.state).toEqual(replay('lab-1', [{ kind: 'roll', dice: 3 }, { kind: 'roll', dice: 2 }]));
    expect($('#last-roll .dice').getAttribute('aria-label')).toMatch(/^Dice: \d, \d$/u);
  });

  it('disables the rolls the chips cannot pay', () => {
    mount();
    startSeed('lab-1');
    click('[data-dice="5"]');
    click('[data-dice="4"]');
    expect(text('#st-chips')).toBe('1 of 20');
    const disabled = [1, 2, 3, 4, 5].map((n) => $<HTMLButtonElement>(`[data-dice="${n}"]`).disabled);
    expect(disabled).toEqual([false, true, true, true, true]);
    expect($<HTMLButtonElement>('#rest').disabled).toBe(false);
  });

  it('undo replays from the seed to the state before the last input', () => {
    const { app } = mount();
    startSeed('lab-1');
    expect($<HTMLButtonElement>('#undo').disabled).toBe(true);
    click('[data-dice="3"]');
    click('#rest');
    click('#undo');
    expect(app.session()?.state).toEqual(replay('lab-1', [{ kind: 'roll', dice: 3 }]));
    expect(text('#status')).toBe(`Undone. Replayed 1 input from the seed: round 1, score ${app.session()?.state.score}.`);
  });

  it('keys 1 to 5, R and U act when focus is not in a field', () => {
    const { app } = mount();
    startSeed('lab-1');
    const key = (k: string, target: Element = $('#actions')) => target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    key('2');
    key('r');
    expect(app.session()?.inputs).toEqual([{ kind: 'roll', dice: 2 }, { kind: 'rest' }]);
    key('u');
    expect(app.session()?.inputs).toEqual([{ kind: 'roll', dice: 2 }]);
    key('3', $('#import-file'));
    expect(app.session()?.inputs).toHaveLength(1);
    // From the Start button, where focus stays after a new run.
    key('1', $('#seed-form button[type="submit"]'));
    expect(app.session()?.inputs).toHaveLength(2);
  });

  it('shows a seed that looks like markup as text', () => {
    mount();
    startSeed('<img src=x onerror=alert(1)>');
    expect(text('#st-seed')).toBe('<img src=x onerror=alert(1)>');
    expect(document.querySelectorAll('img')).toHaveLength(0);
  });

  it('plays to the end: every action disabled, the final score announced, focus on Export', () => {
    mount();
    startSeed('lab-1');
    for (let i = 0; i < 20; i++) click('#rest');
    expect(text('#st-round')).toBe('20 of 20');
    expect(text('#status')).toContain('The tournament is over. Final score 20.');
    expect([...document.querySelectorAll<HTMLButtonElement>('#actions button:not(#undo)')].every((b) => b.disabled)).toBe(true);
    expect(document.activeElement?.id).toBe('export');
  });

  it('Random seed fills the field and starts', () => {
    const { app } = mount();
    click('#random-seed');
    expect($<HTMLInputElement>('#seed').value).toBe('random-7');
    expect(app.session()?.state.seed).toBe('random-7');
  });
});

describe('run file', () => {
  it('export shows a download link to the sealed record, and a new input revokes it', () => {
    const { urls, revoked } = mount();
    startSeed('lab-1');
    click('[data-dice="3"]');
    click('#export');
    const link = $<HTMLAnchorElement>('#download');
    expect(link.hidden).toBe(false);
    expect(link.download).toMatch(/^run-lab-1-[0-9a-f]{8}\.json$/u);
    expect(link.textContent).toBe(`Download ${link.download}`);
    expect(document.activeElement).toBe(link);
    const body = JSON.parse(urls.get(link.getAttribute('href') ?? '') ?? '{}') as Record<string, unknown>;
    expect(body).toMatchObject({ seed: 'lab-1', inputs: [{ kind: 'roll', dice: 3 }] });
    click('#rest');
    expect(link.hidden).toBe(true);
    expect(revoked).toEqual(['blob:test/1']);
  });

  it('import replays the file, reports both hashes as matching and loads the run', async () => {
    const { urls, app } = mount();
    startSeed('lab-2');
    click('[data-dice="4"]');
    click('#rest');
    click('#export');
    const exported = urls.get($<HTMLAnchorElement>('#download').getAttribute('href') ?? '') ?? '';
    mount();
    chooseFile('run.json', exported);
    await vi.waitFor(() => expect(text('#import-result')).toContain('Final state hash'));
    expect([...document.querySelectorAll('#import-result li')].map((li) => li.className)).toEqual(['good', 'good']);
    expect(text('#import-result')).toContain('run.json: seed "lab-2", 2 inputs, ruleset dice-1.');
    expect($<HTMLInputElement>('#seed').value).toBe('lab-2');
    expect(app.session()).not.toBeNull();
  });

  it('an edited file still replays, and the inputs hash is reported as not matching', async () => {
    const { urls } = mount();
    startSeed('lab-3');
    click('[data-dice="5"]');
    click('#export');
    const exported = urls.get($<HTMLAnchorElement>('#download').getAttribute('href') ?? '') ?? '';
    chooseFile('edited.json', exported.replace('"dice": 5', '"dice": 1'));
    await vi.waitFor(() => expect(text('#import-result')).toContain('Inputs hash'));
    expect([...document.querySelectorAll('#import-result li')].map((li) => li.className)).toEqual(['bad', 'bad']);
    expect(text('#import-result')).toContain('does not match');
  });

  it('a file that cannot be replayed says why', async () => {
    mount();
    chooseFile('bad.json', JSON.stringify({ format: 'dsim-run/1', rulesetVersion: 'dice-1', seed: 's', inputs: [{ kind: 'roll', dice: 5 }, { kind: 'roll', dice: 5 }, { kind: 'roll', dice: 5 }] }));
    await vi.waitFor(() => expect(text('#import-result')).toContain('could not be replayed'));
    expect(text('#import-result')).toBe('bad.json could not be replayed: rolling 5 dice costs 5 chips; there are 0.');
  });

  it('refuses a file over 64 KB without reading it', () => {
    mount();
    const input = $<HTMLInputElement>('#import-file');
    const file = new File(['{}'], 'huge.json', { type: 'application/json' });
    Object.defineProperty(file, 'size', { value: 5 * 1024 * 1024 * 1024 });
    const read = vi.spyOn(file, 'text');
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    input.dispatchEvent(new Event('change'));
    expect(read).not.toHaveBeenCalled();
    expect(text('#import-result')).toBe(`huge.json could not be replayed: the file is ${5 * 1024 * 1024 * 1024} bytes; a run file is at most 65536.`);
  });
});

describe('batch', () => {
  it('runs the batch, draws the histogram, shows the report hash and a table', () => {
    const harness = mount();
    click('#tab-batch');
    $<HTMLInputElement>('#runs').value = '300';
    $<HTMLFormElement>('#batch-form').requestSubmit();
    expect(harness.batches).toBe(1);
    expect(text('#batch-status')).toMatch(/^Done: 300 runs, mean score \d+\.\d\d, median \d+\.$/u);
    expect(document.querySelectorAll('#batch-result svg.histogram .bars rect').length).toBeGreaterThan(3);
    expect(text('#batch-result caption')).toBe('300 runs, policy roll-3, ruleset dice-1, seeds batch-0 to batch-299');
    expect(text('#batch-result .hash-line')).toMatch(/Report hash [0-9a-f]{16}\. .* Took 125 ms\./u);
    expect($<HTMLButtonElement>('#run-batch').disabled).toBe(false);
    expect($('#batch-progress').hidden).toBe(true);
  });

  it('the same form gives the same report hash twice', () => {
    mount();
    $<HTMLFormElement>('#batch-form').requestSubmit();
    const first = $('#batch-result code').getAttribute('title');
    $<HTMLFormElement>('#batch-form').requestSubmit();
    expect($('#batch-result code').getAttribute('title')).toBe(first);
  });

  it('refuses an out-of-range run count without starting', () => {
    const harness = mount();
    $<HTMLInputElement>('#runs').value = '20000';
    $<HTMLFormElement>('#batch-form').requestSubmit();
    expect(harness.batches).toBe(0);
    expect(text('#batch-status')).toBe('Not started: runs must be a whole number from 1 to 10,000.');
  });

  it('shows progress while running, announces it by quarters, and Cancel stops it', () => {
    let send: (m: BatchMessage) => void = () => undefined;
    let cancelled = 0;
    mount({
      start(_request, onMessage) {
        send = onMessage;
        return () => {
          cancelled += 1;
        };
      },
    });
    click('#tab-batch');
    $<HTMLFormElement>('#batch-form').requestSubmit();
    expect($('#batch-progress').hidden).toBe(false);
    expect($('#cancel-batch').hidden).toBe(false);
    expect($<HTMLButtonElement>('#run-batch').disabled).toBe(true);
    send({ type: 'progress', done: 50, total: 1000 });
    expect($<HTMLProgressElement>('#batch-progress').value).toBe(50);
    expect(text('#batch-status')).toBe('Running 1,000 runs in a worker...');
    send({ type: 'progress', done: 250, total: 1000 });
    expect(text('#batch-status')).toBe('250 of 1,000 runs played.');
    click('#cancel-batch');
    expect(cancelled).toBe(1);
    expect(text('#batch-status')).toBe('Cancelled. No report.');
    expect($<HTMLButtonElement>('#run-batch').disabled).toBe(false);
    expect(document.activeElement?.id).toBe('run-batch');
  });

  it('a worker error is reported and the form is usable again', () => {
    mount({
      start(_request, onMessage) {
        onMessage({ type: 'error', message: 'the worker stopped' });
        return () => undefined;
      },
    });
    $<HTMLFormElement>('#batch-form').requestSubmit();
    expect(text('#batch-status')).toBe('The batch failed: the worker stopped.');
    expect($<HTMLButtonElement>('#run-batch').disabled).toBe(false);
  });
});

describe('tabs', () => {
  it('follow the ARIA tab pattern with arrow keys, Home and End', () => {
    mount();
    const play = $<HTMLButtonElement>('#tab-play');
    play.focus();
    play.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(document.activeElement?.id).toBe('tab-batch');
    expect($('#panel-batch').hidden).toBe(false);
    expect($('#panel-play').hidden).toBe(true);
    $('#tab-batch').dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(document.activeElement?.id).toBe('tab-about');
    $('#tab-about').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(document.activeElement?.id).toBe('tab-play');
    expect([...document.querySelectorAll('[role="tab"]')].map((t) => t.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);
  });

  it('every form control has a label', () => {
    mount();
    for (const control of document.querySelectorAll('input, select')) {
      expect(document.querySelector(`label[for="${control.id}"]`), control.id).not.toBeNull();
    }
  });
});
