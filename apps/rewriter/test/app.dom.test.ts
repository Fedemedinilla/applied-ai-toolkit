// @vitest-environment jsdom
//
// The page in a DOM, against the real index.html and a scripted server: the demo when there is no
// server, the form when there is one, the three panels, reverting and keeping changes by keyboard,
// failures, and the CV kept out of storage.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { mountApp, type AppDeps } from '../src/app.ts';
import { asDemoSet } from '../src/demo.ts';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '../index.html'), 'utf8');
const examplesText = readFileSync(join(here, '../demo/examples.json'), 'utf8');
const demo = asDemoSet(JSON.parse(examplesText));
if (demo === null) throw new Error('demo/examples.json does not parse');
const [heavy] = demo.examples;
if (heavy === undefined) throw new Error('no example');

type Answer = { status: number; body: unknown } | 'network' | 'hang';

interface Harness {
  calls: Array<{ url: string; body: unknown }>;
  queue: Answer[];
  copied: string[];
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};
const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`${sel} not found`);
  return el;
};
const text = (sel: string): string => $(sel).textContent ?? '';

async function mount(options: { health?: number | 'network'; healthBody?: unknown; examples?: number; copy?: boolean | 'fail'; rewriteTimeoutMs?: number } = {}): Promise<Harness> {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  document.body.replaceWith(document.importNode(parsed.body, true));
  const h: Harness = { calls: [], queue: [], copied: [] };
  const deps: AppDeps = {
    ...(options.rewriteTimeoutMs === undefined ? {} : { rewriteTimeoutMs: options.rewriteTimeoutMs }),
    ...(options.copy === false
      ? {}
      : {
          copy: async (t: string) => {
            if (options.copy === 'fail') throw new Error('denied');
            h.copied.push(t);
          },
        }),
    fetch: async (input, init) => {
      h.calls.push({ url: input, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
      if (input === './api/health') {
        if (options.health === 'network') throw new TypeError('Failed to fetch');
        const status = options.health ?? 404;
        const body = options.healthBody ?? (status === 200 ? { ok: true } : status === 503 ? { ok: false } : '<h1>404</h1>');
        return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
      }
      if (input === './examples.json') return new Response(examplesText, { status: options.examples ?? 200 });
      const next = h.queue.shift();
      if (next === undefined) throw new Error(`unexpected request to ${input}`);
      if (next === 'network') throw new TypeError('Failed to fetch');
      if (next === 'hang') {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        });
      }
      return new Response(JSON.stringify(next.body), { status: next.status });
    },
  };
  await mountApp(document, deps).ready;
  await settle();
  return h;
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe('demo mode', () => {
  it('starts when ./api/health is a 404, as on GitHub Pages, and makes no rewrite call', async () => {
    const h = await mount({ health: 404 });
    expect($('#mode').dataset['mode']).toBe('demo');
    expect(text('#mode')).toMatch(/no server behind this page/u);
    expect($('#form').hidden).toBe(true);
    expect($('#demo').hidden).toBe(false);
    expect(h.calls.map((c) => c.url)).toEqual(['./api/health', './examples.json']);
  });

  it('starts too when the health check fails, and says so when a server has no key', async () => {
    await mount({ health: 'network' });
    expect($('#demo').hidden).toBe(false);
    await mount({ health: 503 });
    expect(text('#mode')).toMatch(/without ANTHROPIC_API_KEY/u);
    expect($('#demo').hidden).toBe(false);
  });

  it('takes a 200 that is not {"ok": true} as no server', async () => {
    await mount({ health: 200, healthBody: '<!doctype html><title>SPA fallback</title>' });
    expect($('#demo').hidden).toBe(false);
    expect($('#form').hidden).toBe(true);
  });

  it('lists every example as a labelled radio, says they are recorded and invented, and shows the first', async () => {
    await mount();
    const radios = [...document.querySelectorAll<HTMLInputElement>('#demo-list input[type=radio]')];
    expect(radios).toHaveLength(demo.examples.length);
    expect(radios[0]?.checked).toBe(true);
    for (const r of radios) expect(r.closest('label')?.textContent?.trim()).not.toBe('');
    expect(text('#demo-intro')).toContain(`recorded on ${demo.recorded}`);
    expect(text('#demo-intro')).toMatch(/invented/u);
    expect($('#result').hidden).toBe(false);
    expect(text('#rewritten')).toBe(heavy.result.rewritten);
    expect(text('#original')).toBe(heavy.input.text);
    expect(text('#cost')).toMatch(/as recorded/u);
  });

  it('switches example on a radio change and announces it', async () => {
    await mount();
    const good = demo.examples.find((e) => e.id === 'en-email-good');
    const radio = $<HTMLInputElement>(`#demo-list input[value="${good?.id}"]`);
    radio.checked = true;
    radio.dispatchEvent(new Event('change'));
    expect(text('#rewritten')).toBe(good?.result.rewritten);
    expect(text('#changes')).toBe('No change.');
    expect($('#keep-all').hidden).toBe(true);
    expect(text('#status')).toContain(good?.title ?? '?');
    expect($('#original').lang).toBe('en');
  });

  it('says so when the recordings cannot be loaded', async () => {
    await mount({ examples: 404 });
    expect(text('#status')).toMatch(/could not be loaded/u);
    expect($('#result').hidden).toBe(true);
  });
});

describe('the three panels', () => {
  it('panel 1 marks every finding in the original and lists it', async () => {
    await mount();
    const marks = document.querySelectorAll('#original mark');
    expect(marks.length).toBeGreaterThan(0);
    expect(document.querySelectorAll('#findings li')).toHaveLength(heavy.result.lint.before.findings.length);
    expect(document.querySelector('#original mark[data-level="1"]')).not.toBeNull();
    expect($('#original').lang).toBe('es');
  });

  it('panel 2 lists the applied changes with buttons and the reverted ones without', async () => {
    await mount();
    const applied = heavy.result.changes.filter((c) => c.status === 'applied');
    const reverted = heavy.result.changes.filter((c) => c.status === 'reverted');
    expect(document.querySelectorAll('#changes li.change')).toHaveLength(applied.length);
    expect(document.querySelectorAll('#changes button')).toHaveLength(applied.length);
    expect($('#reverted-wrap').hidden).toBe(false);
    expect(document.querySelectorAll('#reverted li.change')).toHaveLength(reverted.length);
    expect(document.querySelectorAll('#reverted button')).toHaveLength(0);
    expect(text('#reverted')).toContain(reverted[0]?.revertReason ?? '?');
  });

  it('panel 3 explains the status and shows facts, lint before and after, and the cost', async () => {
    await mount();
    expect(text('#verdict')).toMatch(/^OK /u);
    expect(text('#facts')).toContain('Added from your CV');
    expect(text('#lint')).toMatch(/Before: 14 patterns .*\.After: 7 patterns/su);
    expect(text('#cost')).toBe(`2 model calls, US$${heavy.result.usage.costUsd?.toFixed(4)}, as recorded.`);
    expect(text('#result')).toMatch(/numbers are for the full rewrite as returned/u);
  });

  it('shows a needs-review status in plain words, and an injection flag', async () => {
    await mount();
    const pick = (id: string) => {
      const radio = $<HTMLInputElement>(`#demo-list input[value="${id}"]`);
      radio.checked = true;
      radio.dispatchEvent(new Event('change'));
    };
    pick('es-follow-up-heavy-3');
    expect($('#verdict').dataset['status']).toBe('needs-review');
    expect(text('#verdict')).toMatch(/Needs review .*before you send it/u);
    pick('es-trap-injection-in-text');
    expect(text('#flags')).toMatch(/Reads like an instruction: /u);
  });
});

describe('reverting and keeping changes', () => {
  it('a revert puts the original words back, by keyboard, and focus stays on the button', async () => {
    await mount();
    const first = heavy.result.changes.find((c) => c.status === 'applied');
    if (!first) throw new Error('no applied change');
    const button = $<HTMLButtonElement>(`#change-${first.id} button`);
    expect(button.textContent).toBe(`Revert change ${first.id.slice(1)}`);
    button.focus();
    button.click();
    expect(document.activeElement).toBe(button);
    expect(button.textContent).toBe(`Keep change ${first.id.slice(1)}`);
    expect($(`#change-${first.id}`).dataset['state']).toBe('reverted');
    expect(text('#rewritten')).toContain(first.before);
    expect(text('#status')).toMatch(/reverted: your words are back/u);
    button.click();
    expect(text('#rewritten')).toBe(heavy.result.rewritten);
  });

  it('"Revert every change" gives the original back, and "Keep every change" the rewrite', async () => {
    const h = await mount();
    $('#revert-all').click();
    expect(text('#rewritten')).toBe(heavy.input.text);
    $('#copy').click();
    await settle();
    expect(h.copied.at(-1)).toBe(heavy.input.text);
    $('#keep-all').click();
    expect(text('#rewritten')).toBe(heavy.result.rewritten);
    $('#copy').click();
    await settle();
    expect(h.copied.at(-1)).toBe(heavy.result.rewritten);
    expect(text('#status')).toMatch(/Copied the text, with 5 of 5 changes kept/u);
  });

  it('says how to copy by hand when there is no clipboard or it refuses', async () => {
    await mount({ copy: false });
    $('#copy').click();
    expect(text('#status')).toMatch(/Select the text/u);
    await mount({ copy: 'fail' });
    $('#copy').click();
    await settle();
    expect(text('#status')).toMatch(/did not allow/u);
  });
});

describe('local mode', () => {
  const REPLY = { original: heavy.input.text, result: heavy.result };

  const fillForm = (cv = '# Fictional CV\nDesarrolladora web desde 2023.') => {
    $<HTMLTextAreaElement>('#text').value = heavy.input.text;
    $<HTMLTextAreaElement>('#cv').value = cv;
  };

  it('shows the form when the server has a key, with the options and the CV note', async () => {
    const h = await mount({ health: 200 });
    expect($('#form').hidden).toBe(false);
    expect($('#demo').hidden).toBe(true);
    expect($('#mode').dataset['mode']).toBe('local');
    expect([...$<HTMLSelectElement>('#genre').options].map((o) => o.value)).toEqual(['cover-letter', 'email', 'follow-up', 'whatsapp']);
    expect(text('#cv-hint')).toMatch(/not saved in the browser, and the server does not log it/u);
    expect($<HTMLTextAreaElement>('#cv').getAttribute('autocomplete')).toBe('off');
    expect(h.calls.map((c) => c.url)).toEqual(['./api/health']);
  });

  it('labels every field', async () => {
    await mount({ health: 200 });
    for (const field of document.querySelectorAll('#form textarea, #form input, #form select')) {
      expect(document.querySelector(`label[for="${field.id}"]`), field.id).not.toBeNull();
    }
  });

  it('asks for the text and the CV before sending, and moves focus to the missing one', async () => {
    const h = await mount({ health: 200 });
    $<HTMLButtonElement>('#submit').click();
    expect(text('#status')).toMatch(/text to rewrite/u);
    expect(document.activeElement?.id).toBe('text');
    $<HTMLTextAreaElement>('#text').value = 'Hola.';
    $<HTMLButtonElement>('#submit').click();
    expect(text('#status')).toMatch(/Paste your CV/u);
    expect(document.activeElement?.id).toBe('cv');
    expect(h.calls).toHaveLength(1);
  });

  it('sends exactly what the form holds, shows the result and moves focus to it', async () => {
    const h = await mount({ health: 200 });
    fillForm();
    $<HTMLSelectElement>('#genre').value = 'follow-up';
    $<HTMLSelectElement>('#genre').dispatchEvent(new Event('change'));
    expect($('#previous-field').hidden).toBe(false);
    $<HTMLSelectElement>('#lang').value = 'es';
    $<HTMLSelectElement>('#lang').dispatchEvent(new Event('change'));
    $<HTMLSelectElement>('#variety').value = 'rioplatense';
    $<HTMLSelectElement>('#rewrite-mode').value = 'pulido';
    $<HTMLInputElement>('#to-name').value = '  Gabriela  ';
    $<HTMLTextAreaElement>('#previous').value = 'Hola Gabriela, te mandé el CV.';
    $<HTMLTextAreaElement>('#keep').value = 'Saludos cordiales,\n\n  Estimada Gabriela:  \n';
    h.queue.push({ status: 200, body: REPLY });
    $<HTMLButtonElement>('#submit').click();
    expect($<HTMLButtonElement>('#submit').disabled).toBe(true);
    await settle();
    expect(h.calls[1]?.url).toBe('./api/rewrite');
    expect(h.calls[1]?.body).toEqual({
      text: heavy.input.text,
      genre: 'follow-up',
      lang: 'es',
      variety: 'rioplatense',
      mode: 'pulido',
      recipient: { name: 'Gabriela', previousMessage: 'Hola Gabriela, te mandé el CV.' },
      keep: ['Saludos cordiales,', 'Estimada Gabriela:'],
      cv: '# Fictional CV\nDesarrolladora web desde 2023.',
    });
    expect($('#result').hidden).toBe(false);
    expect(document.activeElement?.id).toBe('result-heading');
    expect(text('#rewritten')).toBe(heavy.result.rewritten);
    expect(text('#status')).toMatch(/Rewritten with 5 changes, 4 taken back by the checks\. Status: OK\./u);
    expect(text('#cost')).not.toMatch(/as recorded/u);
  });

  it('sends no variety for English, and the variety box is disabled', async () => {
    const h = await mount({ health: 200 });
    fillForm();
    $<HTMLSelectElement>('#lang').value = 'en';
    $<HTMLSelectElement>('#lang').dispatchEvent(new Event('change'));
    expect($<HTMLSelectElement>('#variety').disabled).toBe(true);
    h.queue.push({ status: 200, body: REPLY });
    $<HTMLButtonElement>('#submit').click();
    await settle();
    expect(h.calls[1]?.body).not.toHaveProperty('variety');
    expect(h.calls[1]?.body).not.toHaveProperty('recipient');
  });

  it('keeps the CV out of storage, cookies and the URL', async () => {
    const h = await mount({ health: 200 });
    const cv = '# Fictional CV\nUn dato que solo está en este CV: Taller Imaginario 2031.';
    fillForm(cv);
    h.queue.push({ status: 200, body: REPLY });
    $<HTMLButtonElement>('#submit').click();
    await settle();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(document.cookie).not.toContain('Taller');
    expect(window.location.href).not.toContain('Taller');
    // It stays in its box for the next rewrite.
    expect($<HTMLTextAreaElement>('#cv').value).toBe(cv);
  });

  it.each([
    [{ status: 503, body: { error: 'cap_reached' } }, /spending cap is reached/u],
    [{ status: 503, body: { error: 'model_unavailable' } }, /busy or unavailable/u],
    [{ status: 502, body: { error: 'model_unusable' } }, /could not be used/u],
    [{ status: 413, body: { error: 'too_large' } }, /too large/u],
    [{ status: 400, body: { error: 'bad_request', detail: 'cv,variety' } }, /refused the CV, the Spanish variety/u],
    [{ status: 500, body: 'nope' }, /server had an error/u],
    [{ status: 200, body: { original: 'x', result: { rewritten: 1 } } }, /does not recognise/u],
    ['network' as const, /cannot reach the server/u],
  ])('says what went wrong for %j and keeps the form', async (answer, message) => {
    const h = await mount({ health: 200 });
    fillForm();
    h.queue.push(answer);
    $<HTMLButtonElement>('#submit').click();
    await settle();
    expect(text('#status')).toMatch(message);
    expect($<HTMLButtonElement>('#submit').disabled).toBe(false);
    expect($('#result').hidden).toBe(true);
    expect($<HTMLTextAreaElement>('#text').value).toBe(heavy.input.text);
  });

  it('gives up after its deadline', async () => {
    const h = await mount({ health: 200, rewriteTimeoutMs: 20 });
    fillForm();
    h.queue.push('hang');
    $<HTMLButtonElement>('#submit').click();
    await new Promise((resolve) => setTimeout(resolve, 60));
    await settle();
    expect(text('#status')).toMatch(/took too long/u);
  });

  it('shows a result whose changes do not rebuild the text as returned, with no buttons', async () => {
    const h = await mount({ health: 200 });
    fillForm();
    const broken = { ...heavy.result, rewritten: `${heavy.result.rewritten} (edited elsewhere)` };
    h.queue.push({ status: 200, body: { original: heavy.input.text, result: broken } });
    $<HTMLButtonElement>('#submit').click();
    await settle();
    expect(text('#rewritten')).toBe(broken.rewritten);
    expect(document.querySelectorAll('#changes button')).toHaveLength(0);
    expect($('#keep-all').hidden).toBe(true);
    expect(text('#changes-hint')).toMatch(/cannot be rebuilt/u);
  });

  it('renders model text as text, never as markup', async () => {
    const h = await mount({ health: 200 });
    fillForm();
    const evil = '<img src=x onerror="alert(1)">';
    const original = `Hola ${evil}`;
    const result = {
      ...heavy.result,
      rewritten: `Hola <b>x</b>`,
      changes: [{ id: 'e1', span: { start: 5, end: 5 + evil.length }, before: evil, after: '<b>x</b>', reason: '<script>bad()</script>', stage: 'edit', status: 'applied' }],
      flags: [{ kind: 'injection', message: '<img src=y>' }],
    };
    h.queue.push({ status: 200, body: { original, result } });
    $<HTMLButtonElement>('#submit').click();
    await settle();
    expect(document.querySelector('#result img, #result b, #result script')).toBeNull();
    expect(text('#rewritten')).toBe('Hola <b>x</b>');
  });
});
