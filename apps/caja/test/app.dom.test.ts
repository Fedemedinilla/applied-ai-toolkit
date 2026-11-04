// @vitest-environment jsdom
//
// The entry flow in a DOM, against the real index.html markup: type a sentence, read the row,
// answer the question when there is one, and find the row saved, totalled and stored.

import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mountApp, type AppDeps } from '../src/app.ts';
import { BACKUP_PREFIX, STORAGE_KEY, type KeyValue } from '../src/storage.ts';
import type { Recognition } from '../src/speech.ts';

// Paths, not URL objects: under jsdom the global URL is jsdom's, which node:fs does not accept.
const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '../index.html'), 'utf8');
const corpusJson: unknown = JSON.parse(readFileSync(join(here, '../../../amount-parser/corpus/corpus.json'), 'utf8'));

class MemoryStore implements KeyValue {
  data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

interface Harness {
  store: MemoryStore;
  downloads: Array<{ fileName: string; text: string }>;
}

function mount(overrides: Partial<AppDeps> = {}): Harness {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  document.body.replaceWith(document.importNode(parsed.body, true));
  const store = new MemoryStore();
  const downloads: Harness['downloads'] = [];
  let n = 0;
  mountApp(document, {
    storage: store,
    now: () => new Date(2026, 10, 4, 10, 30 + n),
    newId: () => `id-${++n}`,
    loadCorpus: async () => corpusJson,
    recognition: null,
    download: (fileName, text) => downloads.push({ fileName, text }),
    ...overrides,
  });
  return { store, downloads };
}

const $ = <T extends Element = HTMLElement>(selector: string): T => {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`missing ${selector}`);
  return el;
};

function type(sentence: string): void {
  $<HTMLInputElement>('#entry-input').value = sentence;
  $<HTMLFormElement>('#entry-form').requestSubmit();
}

const click = (selector: string): void => $<HTMLButtonElement>(selector).click();
/** Text nodes joined with single spaces, the way a screen reader moves through them. */
function words(el: Node): string {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = (n.textContent ?? '').replace(/\s+/gu, ' ').trim();
    if (t) parts.push(t);
  }
  return parts.join(' ');
}
const text = (selector: string): string => words($(selector));
const rows = (): string[] => [...document.querySelectorAll('#days .row')].map(words);
const todayTotals = (): string => text('#days .day:first-child .totals');

describe('entry flow', () => {
  let h: Harness;
  beforeEach(() => {
    h = mount();
  });

  it('a plain sentence shows the row with the matched words marked, and saves it', () => {
    type('pagué la luz 45 lucas');
    expect($('#preview').getAttribute('aria-live')).toBe('polite');
    expect(text('#preview .amount')).toBe('$45.000');
    expect([...document.querySelectorAll('#preview mark')].map((m) => [m.textContent, m.getAttribute('data-role')])).toEqual([['45 lucas', 'amount']]);
    expect(text('#preview .facts')).toContain('Gasto por "pagué"');
    expect(text('#preview .facts')).toContain('Servicios por "luz"');
    // Focus moves to "Guardar", so Enter, Enter saves from the keyboard.
    expect(document.activeElement?.textContent).toBe('Guardar');

    click('[data-action="save"]');
    expect(rows()).toEqual(['10:30 pagué la luz 45 lucas Servicios · 45 lucas Gasto −$45.000']);
    expect(todayTotals()).toBe('Entró $0 Salió $45.000 Neto −$45.000');
    expect(text('#status')).toContain('Guardado: gasto de $45.000 en Servicios.');
    expect($('#preview').children).toHaveLength(0);
    expect($<HTMLInputElement>('#entry-input').value).toBe('');
    expect(JSON.parse(h.store.getItem(STORAGE_KEY) ?? '[]')).toHaveLength(1);
  });

  it('an ambiguous sentence asks, saves nothing until answered, then saves the chosen reading', () => {
    type('vendí 5 tortas a 8000');
    expect(text('#preview legend')).toBe('¿8000 cada torta o 8000 en total?');
    expect(document.querySelector('[data-action="save"]')).toBeNull();
    expect(rows()).toEqual([]);
    expect(document.activeElement?.getAttribute('data-option')).toBe('0');

    click('[data-option="0"]');
    expect(rows()).toEqual(['10:30 vendí 5 tortas a 8000 Ventas · 5 x 8000 Ingreso +$40.000']);
    expect(todayTotals()).toBe('Entró $40.000 Salió $0 Neto $40.000');
  });

  it('a typed answer is parsed, and a bad one is refused with a message', () => {
    type('vendí el sillón en un palo y pico');
    expect(document.querySelector('[data-option]')).toBeNull();
    const amount = $<HTMLInputElement>('#typed-amount');
    amount.value = 'entre 1 y 2 palos';
    $<HTMLFormElement>('#preview form').requestSubmit();
    expect(text('#preview-error')).toBe('Escribí un solo monto, por ejemplo 45000 o 45 mil.');
    expect(rows()).toEqual([]);

    amount.value = '1.250.000';
    $<HTMLFormElement>('#preview form').requestSubmit();
    expect(rows()[0]).toContain('+$1.250.000');
  });

  it('money in and out in one sentence cannot be saved; it asks for two entries', () => {
    type('cobré 50 mil de la obra y pagué 12 mil de materiales');
    expect(text('#preview legend')).toContain('Cargá cada movimiento por separado');
    expect(document.querySelector('#typed-amount')).toBeNull();
    expect(document.querySelector('[data-option]')).toBeNull();
    // Nothing here can be saved, so no guessed kind and no flip button either.
    expect(document.querySelector('#preview .facts')).toBeNull();
    expect(document.querySelector('[data-action="flip"]')).toBeNull();
  });

  it('editing the sentence after it was read clears the preview, so the old reading cannot be saved', () => {
    type('pagué la luz 45 lucas');
    const input = $<HTMLInputElement>('#entry-input');
    input.value = 'pagué la luz 54 lucas';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(document.querySelector('[data-action="save"]')).toBeNull();
    expect($('#preview').children).toHaveLength(0);
    $<HTMLFormElement>('#entry-form').requestSubmit();
    expect(text('#preview .amount')).toBe('$54.000');
  });

  it('the "type something first" hint goes away once a sentence is read', () => {
    type('   ');
    expect(text('#status')).toBe('Escribí una frase primero.');
    type('pagué la luz 45 lucas');
    expect(text('#status')).toBe('');
  });

  it('flipping income and expense re-picks the category before saving', () => {
    type('me devolvieron 12 mil de la harina');
    expect(text('#preview .facts')).toContain('Ingreso');
    click('[data-action="flip"]');
    expect(text('#preview .facts')).toContain('Gasto elegido por vos');
    expect(text('#preview .facts')).toContain('Materia prima por "harina"');
    click('[data-action="save"]');
    expect(rows()[0]).toContain('Materia prima');
    expect(rows()[0]).toContain('−$12.000');
  });

  it('no amount: says so and saves nothing', () => {
    type('hoy vino poca gente');
    expect(text('#preview')).toContain('No encontré un monto');
    expect(rows()).toEqual([]);
  });

  it('undo from the status line and from the book; daily totals follow', () => {
    type('vendí 3 docenas a 12 mil la docena');
    click('[data-action="save"]');
    type('pagué la luz 45 lucas');
    click('[data-action="save"]');
    expect(todayTotals()).toBe('Entró $36.000 Salió $45.000 Neto −$9.000');

    click('#status [data-undo]');
    expect(rows()).toHaveLength(1);
    expect(todayTotals()).toBe('Entró $36.000 Salió $0 Neto $36.000');

    click('#undo');
    expect(rows()).toEqual([]);
    expect($<HTMLButtonElement>('#undo').disabled).toBe(true);
    expect(JSON.parse(h.store.getItem(STORAGE_KEY) ?? 'null')).toEqual([]);
  });

  it('exports the book as CSV with a byte order mark', () => {
    type('vendí 3 docenas a 12 mil la docena');
    click('[data-action="save"]');
    click('#export');
    expect(h.downloads).toHaveLength(1);
    expect(h.downloads[0]?.fileName).toBe('caja-2026-11-04.csv');
    expect(h.downloads[0]?.text.startsWith('﻿fecha,hora,tipo,monto')).toBe(true);
    expect(h.downloads[0]?.text).toContain('ingreso,36000,Ventas,vendí 3 docenas a 12 mil la docena,3 x 12 mil,no');
  });

  it('example buttons fill the input and read it', () => {
    click('[data-example="vendí 5 tortas a 8000"]');
    expect($<HTMLInputElement>('#entry-input').value).toBe('vendí 5 tortas a 8000');
    expect(text('#preview legend')).toBe('¿8000 cada torta o 8000 en total?');
  });
});

describe('storage', () => {
  it('rows saved earlier are listed on start', () => {
    const first = mount();
    type('pagué la luz 45 lucas');
    click('[data-action="save"]');
    const saved = first.store.getItem(STORAGE_KEY) ?? '';

    const store = new MemoryStore();
    store.setItem(STORAGE_KEY, saved);
    mount({ storage: store });
    expect(rows()).toHaveLength(1);
  });

  it('stored text that does not load is copied before the first save, never overwritten', () => {
    const store = new MemoryStore();
    store.setItem(STORAGE_KEY, '[{"id":"x","amount":"mucho"}');
    mount({ storage: store });
    expect($('#storage-warning').hidden).toBe(false);
    expect(text('#storage-warning')).toContain(`No se borró: quedó una copia en este navegador, con el nombre ${BACKUP_PREFIX}`);
    type('pagué la luz 45 lucas');
    click('[data-action="save"]');
    expect(JSON.parse(store.getItem(STORAGE_KEY) ?? '[]')).toHaveLength(1);
    const backups = [...store.data.entries()].filter(([key]) => key.startsWith(BACKUP_PREFIX));
    expect(backups.map(([, value]) => value)).toEqual(['[{"id":"x","amount":"mucho"}']);
  });

  it('when no copy can be made, the app keeps rows in memory and does not write', () => {
    const store = new MemoryStore();
    store.setItem(STORAGE_KEY, '{oops');
    store.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    mount({ storage: store });
    expect(text('#storage-warning')).toContain('Para no borrarlo, la caja no va a guardar nada en este navegador.');
    type('pagué la luz 45 lucas');
    click('[data-action="save"]');
    expect(rows()).toHaveLength(1);
    expect(store.getItem(STORAGE_KEY)).toBe('{oops');
    expect(text('#storage-warning')).toContain('Exportá el CSV');
  });

  it('warns when the browser does not keep data, and the till still works', () => {
    mount({ storage: null });
    expect($('#storage-warning').hidden).toBe(false);
    expect(text('#storage-warning')).toContain('Exportá el CSV');
    type('pagué la luz 45 lucas');
    click('[data-action="save"]');
    expect(rows()).toHaveLength(1);
  });
});

describe('dictation', () => {
  it('the button is hidden when the browser has no speech recognition', () => {
    mount();
    expect($('#dictate').hidden).toBe(true);
  });

  it('with recognition: the transcript fills the input and is read', () => {
    let instance: Recognition | null = null;
    class FakeRecognition implements Recognition {
      lang = '';
      interimResults = true;
      maxAlternatives = 5;
      onresult: Recognition['onresult'] = null;
      onerror: Recognition['onerror'] = null;
      onend: Recognition['onend'] = null;
      constructor() {
        instance = this;
      }
      start(): void {}
      stop(): void {
        this.onend?.();
      }
    }
    mount({ recognition: FakeRecognition });
    const button = $<HTMLButtonElement>('#dictate');
    expect(button.hidden).toBe(false);
    button.click();
    expect(button.getAttribute('aria-pressed')).toBe('true');
    const rec = instance as Recognition | null;
    expect(rec?.lang).toBe('es-AR');
    rec?.onresult?.({ results: [[{ transcript: 'vendí 3 docenas a 12 mil la docena' }]] });
    rec?.onend?.();
    expect($<HTMLInputElement>('#entry-input').value).toBe('vendí 3 docenas a 12 mil la docena');
    expect(text('#preview .amount')).toBe('$36.000');
    expect(button.getAttribute('aria-pressed')).toBe('false');

    button.click();
    (instance as Recognition | null)?.onerror?.({ error: 'network' });
    expect(text('#status')).toBe('El dictado de este navegador necesita conexión. Escribí la frase.');
  });
});

describe('tabs and the phrases tab', () => {
  it('arrow keys move between tabs; the phrases tab loads the corpus once and filters it', async () => {
    mount();
    const tab = $<HTMLButtonElement>('#tab-caja');
    tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect($('#tab-frases').getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement?.id).toBe('tab-frases');
    expect($('#panel-caja').hidden).toBe(true);
    expect($('#panel-frases').hidden).toBe(false);

    await vi_waitFor(() => document.querySelectorAll('#corpus-list li').length > 0);
    expect(document.querySelectorAll('#corpus-list li')).toHaveLength(165);
    expect(text('#corpus-count')).toBe('Mostrando 165 de 165 frases. El parser coincide con el corpus en 164 de 165.');

    const q = $<HTMLInputElement>('#corpus-q');
    q.value = 'docena';
    q.dispatchEvent(new Event('input', { bubbles: true }));
    const shown = document.querySelectorAll('#corpus-list li').length;
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(165);
    expect(text('#corpus-list li:first-child')).toContain('Familia');

    $<HTMLButtonElement>('#tab-frases').dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect($('#panel-como').hidden).toBe(false);
  });

  it('a failed corpus load says so, and opening the tab again retries', async () => {
    let calls = 0;
    mount({
      loadCorpus: async () => {
        calls++;
        if (calls === 1) throw new Error('offline');
        return corpusJson;
      },
    });
    click('#tab-frases');
    await vi_waitFor(() => text('#corpus-count').startsWith('No se pudieron'));
    click('#tab-caja');
    click('#tab-frases');
    await vi_waitFor(() => document.querySelectorAll('#corpus-list li').length === 165);
    expect(calls).toBe(2);
    // Opening it once more does not fetch again.
    click('#tab-caja');
    click('#tab-frases');
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toBe(2);
  });
});

async function vi_waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('condition not met');
}
