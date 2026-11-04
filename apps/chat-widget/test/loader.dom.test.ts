// @vitest-environment jsdom
// The loader in jsdom: what it mounts, what it sends, and that no text from the tenant, the
// visitor or the model is ever parsed as HTML.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isPublicConfig, MAX_REPLY_CHARS, MESSAGES, mountWidget, optionsFromScript, textOn, type MountedWidget, type PublicConfig } from '../src/widget.ts';

const BASE = 'https://widget.example/';
const CONFIG: PublicConfig = {
  header: 'Panadería Sol',
  welcome: 'Hola. ¿En qué te puedo ayudar?',
  placeholder: 'Escribe tu pregunta',
  primaryColor: '#1f6f5c',
  font: 'system-ui',
  suggestedQuestions: ['¿Abren los domingos?'],
};

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(answers: Array<() => Response | Promise<Response>>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    const next = answers.shift();
    if (!next) throw new TypeError('Failed to fetch');
    return next();
  }) as typeof fetch;
  return { fetch: fetchFn, calls };
}

const ok = (body: unknown, status = 200) => (): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Fails the test if anything sets innerHTML, outerHTML or calls insertAdjacentHTML. */
function forbidHtmlParsing(): () => void {
  const spies = [
    vi.spyOn(Element.prototype, 'innerHTML', 'set'),
    vi.spyOn(Element.prototype, 'outerHTML', 'set'),
    vi.spyOn(Element.prototype, 'insertAdjacentHTML'),
    vi.spyOn(ShadowRoot.prototype, 'innerHTML', 'set'),
  ];
  return () => {
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  };
}

async function mount(answers: Array<() => Response | Promise<Response>>, config: unknown = CONFIG): Promise<{ widget: MountedWidget; calls: Call[] }> {
  const { fetch: f, calls } = fakeFetch([ok(config), ...answers]);
  const widget = await mountWidget({ tenant: 'panaderia-sol', base: BASE, fetch: f, sessionId: '33333333-3333-4333-8333-333333333333' });
  if (!widget) throw new Error('widget did not mount');
  return { widget, calls };
}

const q = <T extends Element>(root: ShadowRoot, selector: string): T => {
  const node = root.querySelector<T>(selector);
  if (!node) throw new Error(`missing ${selector}`);
  return node;
};
const texts = (root: ShadowRoot): string[] => [...root.querySelectorAll('.msg')].map((n) => n.textContent ?? '');

beforeEach(() => {
  document.body.replaceChildren();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('the script tag', () => {
  const script = (attrs: Record<string, string>): HTMLScriptElement => {
    const s = document.createElement('script');
    for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, v);
    return s;
  };

  it('reads the tenant, and the backend from the script URL unless data-api says otherwise', () => {
    expect(optionsFromScript(script({ src: 'https://widget.example/embed/chat.js', 'data-tenant': 'panaderia-sol' }))).toEqual({ tenant: 'panaderia-sol', base: 'https://widget.example/' });
    expect(optionsFromScript(script({ src: 'https://cdn.example/embed/chat.js?v=2', 'data-tenant': 'panaderia-sol', 'data-api': 'https://api.example/chat' }))).toEqual({
      tenant: 'panaderia-sol',
      base: 'https://api.example/chat/',
    });
  });

  it('refuses a missing or malformed tenant and a non-HTTP backend', () => {
    expect(optionsFromScript(script({ src: 'https://widget.example/embed/chat.js' }))).toBeNull();
    expect(optionsFromScript(script({ src: 'https://widget.example/embed/chat.js', 'data-tenant': '<b>x</b>' }))).toBeNull();
    expect(optionsFromScript(script({ src: 'https://widget.example/embed/chat.js', 'data-tenant': 'panaderia-sol', 'data-api': 'javascript:alert(1)' }))).toBeNull();
  });
});

describe('mounting', () => {
  it('mounts one host element with an open shadow root, and its styles inside it', async () => {
    const before = document.head.children.length;
    const { widget } = await mount([]);
    expect(document.body.children).toHaveLength(1);
    expect(document.body.firstElementChild).toBe(widget.host);
    expect(widget.host.shadowRoot).toBe(widget.root);
    expect(document.head.children.length).toBe(before);
    // jsdom has no constructed stylesheets, so this exercises the <style> fallback.
    const adopted = 'adoptedStyleSheets' in widget.root ? widget.root.adoptedStyleSheets.length : 0;
    expect(adopted > 0 || widget.root.querySelector('style')?.textContent?.includes(':host') === true).toBe(true);
    expect(widget.host.style.getPropertyValue('--cw-accent')).toBe('#1f6f5c');
    expect(widget.host.style.getPropertyValue('--cw-on-accent')).toBe('#ffffff');
  });

  it('fetches the config without credentials and mounts nothing when it fails', async () => {
    for (const answer of [ok({ error: 'unknown_tenant' }, 404), ok({ error: 'paused' }, 403), ok({ ...CONFIG, primaryColor: 'red' }), ok({ ...CONFIG, font: 'x;}' }), () => Promise.reject(new TypeError('offline'))]) {
      document.body.replaceChildren();
      const { fetch: f, calls } = fakeFetch([answer]);
      expect(await mountWidget({ tenant: 'panaderia-sol', base: BASE, fetch: f })).toBeNull();
      expect(document.body.children).toHaveLength(0);
      expect(calls[0]?.url).toBe('https://widget.example/widget/config?tenant=panaderia-sol');
      expect(calls[0]?.init).toMatchObject({ method: 'GET', credentials: 'omit', mode: 'cors' });
    }
  });

  it('mounts once per tenant when the tag appears twice', async () => {
    await mount([]);
    const { fetch: f } = fakeFetch([ok(CONFIG)]);
    expect(await mountWidget({ tenant: 'panaderia-sol', base: BASE, fetch: f })).toBeNull();
    expect(document.body.children).toHaveLength(1);
  });

  it('mounts once when two tags for the same tenant start before either config arrives', async () => {
    const first = fakeFetch([ok(CONFIG)]);
    const second = fakeFetch([ok(CONFIG)]);
    const a = mountWidget({ tenant: 'panaderia-sol', base: BASE, fetch: first.fetch });
    const b = mountWidget({ tenant: 'panaderia-sol', base: BASE, fetch: second.fetch });
    const [mounted, skipped] = await Promise.all([a, b]);
    expect(mounted).not.toBeNull();
    expect(skipped).toBeNull();
    expect(second.calls).toHaveLength(0);
    expect(document.querySelectorAll('[data-chat-widget]')).toHaveLength(1);
  });

  it('removes its placeholder when the config fails, so a later tag can still mount', async () => {
    const failing = fakeFetch([ok({ error: 'unavailable' }, 503)]);
    expect(await mountWidget({ tenant: 'panaderia-sol', base: BASE, fetch: failing.fetch })).toBeNull();
    expect(document.querySelector('[data-chat-widget]')).toBeNull();
    await mount([]);
    expect(document.querySelectorAll('[data-chat-widget]')).toHaveLength(1);
  });
});

describe('text, never markup', () => {
  const payload = '<img src=x onerror="window.pwned=1"><script>window.pwned=1</script>';

  it('renders config, visitor text and replies as text nodes', async () => {
    const check = forbidHtmlParsing();
    const config = { ...CONFIG, header: payload.slice(0, 60), welcome: payload, suggestedQuestions: [payload.slice(0, 80)] };
    const { widget } = await mount([ok({ reply: payload })], config);
    await widget.send(payload);
    expect(widget.root.querySelector('img, script')).toBeNull();
    expect(q(widget.root, '.title').textContent).toBe(payload.slice(0, 60));
    expect(texts(widget.root)).toEqual([payload, payload, payload]);
    expect((window as unknown as Record<string, unknown>)['pwned']).toBeUndefined();
    check();
  });

  it('has no HTML-parsing call in its source', () => {
    const source = readFileSync(join(import.meta.dirname, '../src/widget.ts'), 'utf8');
    for (const sink of ['.innerHTML', '.outerHTML', 'insertAdjacentHTML', 'document.write', 'DOMParser', 'createContextualFragment']) expect(source).not.toContain(sink);
  });
});

describe('sending', () => {
  it('posts a CORS simple request with no credentials, and keeps answered turns as history', async () => {
    const { widget, calls } = await mount([ok({ reply: 'Sí, de 9 a 13 h.' }), ok({ reply: 'Sí.' })]);
    await widget.send('¿Abren los domingos?');
    await widget.send('¿Y los feriados?');
    const [first, second] = [calls[1], calls[2]];
    expect(first?.url).toBe('https://widget.example/widget/chat');
    expect(first?.init).toMatchObject({ method: 'POST', credentials: 'omit', mode: 'cors', headers: { 'content-type': 'text/plain;charset=UTF-8' } });
    expect(Object.keys(first?.init.headers ?? {})).toEqual(['content-type']);
    expect(JSON.parse(String(second?.init.body))).toEqual({
      tenant: 'panaderia-sol',
      sessionId: '33333333-3333-4333-8333-333333333333',
      messages: [
        { role: 'user', content: '¿Abren los domingos?' },
        { role: 'assistant', content: 'Sí, de 9 a 13 h.' },
        { role: 'user', content: '¿Y los feriados?' },
      ],
    });
    expect(texts(widget.root)).toEqual([CONFIG.welcome, '¿Abren los domingos?', 'Sí, de 9 a 13 h.', '¿Y los feriados?', 'Sí.']);
  });

  it('shows its own message for each error code, and leaves a failed turn out of the history', async () => {
    const { widget, calls } = await mount([ok({ error: 'busy' }, 429), () => Promise.reject(new TypeError('offline')), ok({ error: 'something new' }, 500), ok({ reply: 'Ok.' })]);
    await widget.send('uno');
    await widget.send('dos');
    await widget.send('tres');
    await widget.send('cuatro');
    const errors = [...widget.root.querySelectorAll('.msg.error')].map((n) => n.textContent);
    expect(errors).toEqual([MESSAGES['busy'], MESSAGES['network'], MESSAGES['unavailable']]);
    expect(JSON.parse(String(calls[4]?.init.body)).messages).toEqual([{ role: 'user', content: 'cuatro' }]);
  });

  it('sends a suggested question when its chip is pressed, and removes the chips', async () => {
    const { widget, calls } = await mount([ok({ reply: 'No, de martes a sábado.' })]);
    q<HTMLButtonElement>(widget.root, '.chip').click();
    await vi.waitFor(() => expect(texts(widget.root)).toContain('No, de martes a sábado.'));
    expect(JSON.parse(String(calls[1]?.init.body)).messages).toEqual([{ role: 'user', content: '¿Abren los domingos?' }]);
    expect(widget.root.querySelector('.chip')).toBeNull();
  });

  it('keeps a long reply on screen whole and in the history cut to the server bound', async () => {
    const long = 'a'.repeat(MAX_REPLY_CHARS + 500);
    const { widget, calls } = await mount([ok({ reply: long }), ok({ reply: 'Ok.' })]);
    await widget.send('uno');
    await widget.send('dos');
    expect(texts(widget.root)[2]).toHaveLength(long.length);
    const sent = JSON.parse(String(calls[2]?.init.body)).messages as Array<{ content: string }>;
    expect(sent[1]?.content).toHaveLength(MAX_REPLY_CHARS);
  });

  it('ignores a second send while one is in flight', async () => {
    let release: (r: Response) => void = () => undefined;
    const { widget, calls } = await mount([() => new Promise<Response>((resolve) => (release = resolve))]);
    const first = widget.send('uno');
    await widget.send('dos');
    expect(calls).toHaveLength(2);
    release(new Response(JSON.stringify({ reply: 'Ok.' })));
    await first;
    expect(texts(widget.root)).toEqual([CONFIG.welcome, 'uno', 'Ok.']);
  });
});

describe('accessibility', () => {
  it('labels every control, announces new messages, and closes with Escape back to the launcher', async () => {
    const { widget } = await mount([]);
    const root = widget.root;
    const launcher = q<HTMLButtonElement>(root, '.launcher');
    const panel = q<HTMLElement>(root, '.panel');
    const input = q<HTMLInputElement>(root, '.input');
    expect(launcher.getAttribute('aria-expanded')).toBe('false');
    expect(launcher.getAttribute('aria-controls')).toBe(panel.id);
    expect(panel.getAttribute('role')).toBe('dialog');
    expect(root.getElementById(panel.getAttribute('aria-labelledby') ?? '')?.textContent).toBe(CONFIG.header);
    expect(q(root, `label[for="${input.id}"]`).textContent).toBe('Tu mensaje');
    expect(q(root, '.log').getAttribute('role')).toBe('log');
    expect(q(root, '.log').getAttribute('aria-live')).toBe('polite');
    expect(q(root, '.close').getAttribute('aria-label')).toBe('Cerrar chat');

    launcher.click();
    expect(panel.hidden).toBe(false);
    expect(launcher.getAttribute('aria-expanded')).toBe('true');
    expect(root.activeElement).toBe(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(panel.hidden).toBe(true);
    expect(root.activeElement).toBe(launcher);

    // Escape also closes it while focus is on the launcher.
    launcher.click();
    launcher.focus();
    launcher.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(panel.hidden).toBe(true);
    expect(launcher.getAttribute('aria-expanded')).toBe('false');
  });

  it('picks the text color with more contrast on the tenant color', () => {
    expect(textOn('#1f6f5c')).toBe('#ffffff');
    expect(textOn('#f4d35e')).toBe('#111418');
    expect(textOn('#000000')).toBe('#ffffff');
    expect(textOn('#ffffff')).toBe('#111418');
  });

  it('checks the config shape the same way the server publishes it', () => {
    expect(isPublicConfig(CONFIG)).toBe(true);
    expect(isPublicConfig({ ...CONFIG, suggestedQuestions: ['a', 'b', 'c', 'd', 'e'] })).toBe(false);
    expect(isPublicConfig({ ...CONFIG, primaryColor: '#1F6F5C' })).toBe(false);
    expect(isPublicConfig(null)).toBe(false);
  });
});
