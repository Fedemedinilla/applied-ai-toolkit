// @vitest-environment jsdom
//
// Model mode in a DOM, against the real index.html: the toggle appears only when the endpoint
// answers its health check, the verdict's flags show up as questions, and every failure falls back
// to the offline reading. The endpoint is a fake fetch; the verdict and the parser are the real ones.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mountApp, type AppDeps } from '../src/app.ts';
import { STORAGE_KEY, type KeyValue } from '../src/storage.ts';
import type { ApiFetch } from '../src/model-mode.ts';
import type { ModelReading } from '../src/verdict.ts';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '../index.html'), 'utf8');

class MemoryStore implements KeyValue {
  data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Endpoint {
  api: ApiFetch;
  extracts: Array<Record<string, unknown>>;
}

/** A fake of server/handler.ts as the browser sees it. */
function endpoint(extract: (body: Record<string, unknown>) => Response | Promise<Response>, health: () => Response | Promise<Response> = () => json(200, { ok: true })): Endpoint {
  const extracts: Endpoint['extracts'] = [];
  const api: ApiFetch = async (input, init) => {
    if (input === './api/health') return health();
    if (input === './api/extract') {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      extracts.push(body);
      return extract(body);
    }
    throw new Error(`unexpected ${input}`);
  };
  return { api, extracts };
}

const reading = (partial: Partial<ModelReading>): ModelReading => ({
  kind: 'expense',
  category: 'Servicios',
  dateStated: false,
  date: null,
  amount: 45000,
  reason: '"pagué" es un gasto y "luz" un servicio.',
  ...partial,
});

const answering = (partial: Partial<ModelReading>) => () => json(200, { reading: reading(partial) });

function mount(overrides: Partial<AppDeps> = {}): MemoryStore {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  document.body.replaceWith(document.importNode(parsed.body, true));
  const store = new MemoryStore();
  let n = 0;
  mountApp(document, {
    storage: store,
    now: () => new Date(2026, 10, 4, 10, 30 + n),
    newId: () => `id-${++n}`,
    loadCorpus: async () => [],
    recognition: null,
    download: () => undefined,
    timeZone: () => 'America/Argentina/Buenos_Aires',
    ...overrides,
  });
  return store;
}

const $ = <T extends Element = HTMLElement>(selector: string): T => {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`missing ${selector}`);
  return el;
};

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

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('condition not met');
}

/** Mounts, waits for the health check and turns model mode on. */
async function mountWithModel(e: Endpoint): Promise<MemoryStore> {
  const store = mount({ api: e.api });
  await waitFor(() => !$('#model-toggle').hidden);
  $<HTMLInputElement>('#model-mode').click();
  return store;
}

function type(sentence: string): void {
  $<HTMLInputElement>('#entry-input').value = sentence;
  $<HTMLFormElement>('#entry-form').requestSubmit();
}

const card = (): boolean => document.querySelector('form[data-action="model-form"]') !== null;

function pick(selector: string): void {
  const input = $<HTMLInputElement>(selector);
  input.checked = true;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

const save = (): void => $<HTMLButtonElement>('[data-action="model-save"]').click();

describe('the toggle', () => {
  it('does not exist without an endpoint', () => {
    mount();
    expect($('#model-toggle').hidden).toBe(true);
  });

  it.each([
    ['the request fails (offline, or no server)', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['a static host answers with its 404 page', () => new Response('<!doctype html><h1>404</h1>', { status: 404 })],
    ['the server has no key', () => json(503, { ok: false })],
    ['a 200 that is not the health answer', () => new Response('<!doctype html>', { status: 200 })],
  ])('stays hidden when %s', async (_name, health) => {
    let asked = false;
    mount({
      api: endpoint(answering({}), () => {
        asked = true;
        return health();
      }).api,
    });
    await waitFor(() => asked);
    await new Promise((r) => setTimeout(r, 20));
    expect($('#model-toggle').hidden).toBe(true);
  });

  it('appears after the browser comes back online, when the first check failed', async () => {
    let up = false;
    mount({ api: endpoint(answering({}), () => (up ? json(200, { ok: true }) : Promise.reject(new TypeError('Failed to fetch')))).api });
    await new Promise((r) => setTimeout(r, 20));
    expect($('#model-toggle').hidden).toBe(true);
    up = true;
    window.dispatchEvent(new Event('online'));
    await waitFor(() => !$('#model-toggle').hidden);
  });

  it('appears when the endpoint is up, labelled, and off until the owner turns it on', async () => {
    const e = endpoint(answering({}));
    mount({ api: e.api });
    await waitFor(() => !$('#model-toggle').hidden);
    expect($<HTMLInputElement>('#model-mode').checked).toBe(false);
    expect(text('label[for="model-mode"]')).toBe('Leer con IA');
    type('pagué la luz 45 lucas');
    expect(e.extracts).toHaveLength(0);
    expect(document.querySelector('[data-action="save"]')).not.toBeNull();
  });
});

describe('reading with the model', () => {
  it('a confirmed reading: facts say who decided each field, and "ayer" files the row under yesterday', async () => {
    const e = endpoint(answering({ dateStated: true, date: '2026-11-03' }));
    const store = await mountWithModel(e);
    type('ayer pagué la luz 45 lucas');
    expect(text('#preview')).toContain('Leyendo con IA…');
    await waitFor(card);

    expect(e.extracts).toEqual([{ sentence: 'ayer pagué la luz 45 lucas', today: '2026-11-04', timezone: 'America/Argentina/Buenos_Aires' }]);
    const facts = text('#preview .facts');
    expect(facts).toContain('Monto $45.000 por el lector de montos');
    expect(facts).toContain('Tipo Gasto por la IA');
    expect(facts).toContain('Categoría Servicios por la IA');
    expect(facts).toContain('Fecha Ayer por la IA');
    expect(text('#preview .reason')).toBe('La IA: "pagué" es un gasto y "luz" un servicio.');
    expect(document.querySelector('#preview fieldset')).toBeNull();
    expect(document.activeElement?.getAttribute('data-action')).toBe('model-save');

    save();
    expect(text('#days .day[aria-label="Ayer"]')).toContain('Servicios · 45 lucas · con IA Gasto −$45.000');
    const stored = JSON.parse(store.getItem(STORAGE_KEY) ?? '[]') as Array<Record<string, unknown>>;
    expect(stored[0]).toMatchObject({ amount: 45000, category: 'Servicios', day: '2026-11-03', via: 'model' });
  });

  it('a disagreement on the amount is a question with no button for the model figure', async () => {
    await mountWithModel(endpoint(answering({ kind: 'income', category: 'Ventas', amount: 12000 })));
    type('vendí 3 docenas a 12 mil la docena');
    await waitFor(card);
    expect(text('#preview legend')).toBe('La IA leyó $12.000 y el lector de montos $36.000. ¿Cuál es el monto?');
    expect(text('#preview .choices')).not.toContain('$12.000');
    expect(document.activeElement?.getAttribute('name')).toBe('m-amount');

    save();
    expect(text('#preview-error')).toBe('Elegí el monto.');
    expect(rows()).toEqual([]);

    pick('input[name="m-amount"][value="parser"]');
    save();
    expect(rows()[0]).toContain('+$36.000');
  });

  it('a typed amount on that question goes through the parser', async () => {
    await mountWithModel(endpoint(answering({ kind: 'income', category: 'Ventas', amount: 12000 })));
    type('vendí 3 docenas a 12 mil la docena');
    await waitFor(card);
    pick('input[name="m-amount"][value="typed"]');
    $<HTMLInputElement>('#m-typed').value = 'entre 30 y 40 mil';
    save();
    expect(text('#preview-error')).toBe('Escribí un solo monto, por ejemplo 45000 o 45 mil.');
    $<HTMLInputElement>('#m-typed').value = '35 mil';
    save();
    expect(rows()[0]).toContain('+$35.000');
  });

  it('an income under an expense category asks for the category from the income list', async () => {
    await mountWithModel(endpoint(answering({ kind: 'income', category: 'Materia prima', amount: 36000 })));
    type('vendí 3 docenas a 12 mil la docena');
    await waitFor(card);
    expect(text('#preview legend')).toBe('La IA propuso "Materia prima", que es una categoría de gastos. ¿En cuál va?');
    const options = [...document.querySelectorAll<HTMLOptionElement>('#m-category option')].map((o) => o.value);
    expect(options).toEqual(['', 'Ventas', 'Pedidos y encargos']);
    save();
    expect(text('#preview-error')).toBe('Elegí una categoría.');
    $<HTMLSelectElement>('#m-category').value = 'Pedidos y encargos';
    save();
    expect(rows()[0]).toContain('Pedidos y encargos');
  });

  it('an unclear kind is asked, and the category list follows the answer', async () => {
    await mountWithModel(endpoint(answering({ kind: 'unclear', category: null, amount: 20000 })));
    type('harina 20 mil');
    await waitFor(card);
    expect(text('#preview [data-question="kind"] legend')).toBe('La frase no dice si entró o salió plata. ¿Qué fue?');
    expect(document.querySelector('[data-action="model-flip"]')).toBeNull();
    save();
    expect(text('#preview-error')).toBe('Elegí si entró o salió plata.');

    pick('input[name="m-kind"][value="income"]');
    expect(document.activeElement?.getAttribute('value')).toBe('income');
    expect([...document.querySelectorAll<HTMLOptionElement>('#m-category option')].map((o) => o.value)).toEqual(['', 'Ventas', 'Pedidos y encargos']);
    $<HTMLSelectElement>('#m-category').value = 'Ventas';
    save();
    expect(rows()[0]).toContain('Ventas');
    expect(rows()[0]).toContain('+$20.000');
  });

  it('a date that does not check out is asked with a date field limited to the window', async () => {
    await mountWithModel(endpoint(answering({ dateStated: true, date: null })));
    type('el otro día pagué la luz 45 lucas');
    await waitFor(card);
    expect(text('[data-question="date"] legend')).toBe('La frase nombra un día que la IA no pudo fijar. ¿Qué día fue?');
    const field = $<HTMLInputElement>('#m-date');
    expect([field.min, field.max]).toEqual(['2026-10-04', '2026-11-04']);
    field.value = '2026-09-01';
    save();
    expect(text('#preview-error')).toBe('Elegí un día entre hoy y hace 31 días.');
    field.value = '2026-10-30';
    save();
    expect(rows()).toHaveLength(1);
    expect(document.querySelector('#days .day[aria-label="Hoy"] .row')).toBeNull();
  });

  it('a day the model did read but the window rules out is named in the question', async () => {
    await mountWithModel(endpoint(answering({ dateStated: true, date: '2026-11-10' })));
    type('el martes pagué la luz 45 lucas');
    await waitFor(card);
    const legend = text('[data-question="date"] legend');
    expect(legend).toMatch(/^La IA leyó el .*10 de noviembre, que no está entre hoy y hace 31 días\. ¿Qué día fue\?$/u);
    expect(legend).not.toContain('no pudo fijar');
  });

  it('the parser’s own question stays, as choices on the same card', async () => {
    await mountWithModel(endpoint(answering({ kind: 'income', category: 'Ventas', amount: null })));
    type('vendí 5 tortas a 8000');
    await waitFor(card);
    expect(text('#preview legend')).toBe('¿8000 cada torta o 8000 en total?');
    pick('input[name="m-amount"][value="o0"]');
    save();
    expect(rows()[0]).toContain('+$40.000');
  });

  it('flipping the kind on a confirmed card re-picks the category from the keyword table', async () => {
    await mountWithModel(endpoint(answering({ kind: 'income', category: 'Ventas', amount: 12000 })));
    type('me devolvieron 12 mil de la harina');
    await waitFor(card);
    $<HTMLButtonElement>('[data-action="model-flip"]').click();
    expect(text('#preview .facts')).toContain('Tipo Gasto elegido por vos');
    expect(text('#preview .facts')).toContain('Categoría Materia prima por "harina"');
    save();
    expect(rows()[0]).toContain('−$12.000');
  });
});

describe('falling back to the offline reading', () => {
  it.each([
    ['the cap is spent', () => json(503, { error: 'cap_reached' }), 'El modo con IA llegó al tope de gasto del mes. Abajo está la lectura sin IA.'],
    ['the model is busy', () => json(503, { error: 'model_unavailable' }), 'El modo con IA está ocupado ahora. Abajo está la lectura sin IA.'],
    ['the network drops', () => Promise.reject(new TypeError('Failed to fetch')), 'El modo con IA no pudo leer la frase. Abajo está la lectura sin IA.'],
    ['the reply has the wrong shape', () => json(200, { reading: { kind: 'expense', amount: '45000' } }), 'El modo con IA no pudo leer la frase. Abajo está la lectura sin IA.'],
  ])('when %s, says so and shows the offline card', async (_name, reply, message) => {
    await mountWithModel(endpoint(reply));
    type('pagué la luz 45 lucas');
    await waitFor(() => document.querySelector('[data-action="save"]') !== null);
    expect(text('#status')).toBe(message);
    expect(text('#preview .amount')).toBe('$45.000');
    $<HTMLButtonElement>('[data-action="save"]').click();
    expect(rows()[0]).not.toContain('con IA');
  });

  it('"Leer sin IA" while waiting shows the offline card, and the late answer is dropped', async () => {
    let release: (r: Response) => void = () => undefined;
    const late = new Promise<Response>((resolve) => {
      release = resolve;
    });
    await mountWithModel(endpoint(() => late));
    type('pagué la luz 45 lucas');
    $<HTMLButtonElement>('[data-action="model-off"]').click();
    expect(text('#preview .amount')).toBe('$45.000');
    release(json(200, { reading: reading({}) }));
    await new Promise((r) => setTimeout(r, 20));
    expect(card()).toBe(false);
    expect(document.querySelector('[data-action="save"]')).not.toBeNull();
  });

  it('editing the sentence while waiting clears the preview, so the answer cannot land on other words', async () => {
    let release: (r: Response) => void = () => undefined;
    const late = new Promise<Response>((resolve) => {
      release = resolve;
    });
    await mountWithModel(endpoint(() => late));
    type('pagué la luz 45 lucas');
    const input = $<HTMLInputElement>('#entry-input');
    input.value = 'pagué la luz 54 lucas';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    release(json(200, { reading: reading({}) }));
    await new Promise((r) => setTimeout(r, 20));
    expect($('#preview').children).toHaveLength(0);
  });

  it('a sentence the till cannot save is never sent', async () => {
    const e = endpoint(answering({}));
    await mountWithModel(e);
    type('hoy vino poca gente');
    type('cobré 50 mil de la obra y pagué 12 mil de materiales');
    expect(e.extracts).toHaveLength(0);
    expect(text('#preview')).toContain('Cargá cada movimiento por separado');
  });
});
