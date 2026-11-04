// The embedded chat widget. A business pastes one script tag; this code fetches the tenant's public
// config, mounts a launcher and a chat panel inside a Shadow DOM, and talks to POST /widget/chat.
//
// It runs on someone else's page, so:
// - Every piece of text (the tenant's config, the visitor's message, the model's reply) is set
//   with textContent. Nothing is parsed as HTML, and the icons are built with createElementNS.
// - Styles live in the shadow root, so the host's CSS cannot restyle the widget and the widget's
//   CSS cannot leak out. They are attached as a constructed stylesheet where the browser has one,
//   which a strict Content-Security-Policy on the host page does not block.
// - Requests carry no cookies (credentials: 'omit') and no custom headers. The chat POST is a
//   CORS simple request, with no preflight, and the server relies on none.
// - The two config values that reach CSS (the color and the font) are checked again here.
//
// The interface text is neutral Latin American Spanish.

export interface PublicConfig {
  readonly header: string;
  readonly welcome: string;
  readonly placeholder: string;
  readonly primaryColor: string;
  readonly font: string;
  readonly suggestedQuestions: readonly string[];
}

export interface WidgetOptions {
  readonly tenant: string;
  /** The backend's base URL, ending in a slash. Routes are resolved against it. */
  readonly base: string;
  readonly document?: Document;
  readonly fetch?: typeof fetch;
  readonly sessionId?: string;
  /** How long to wait for a reply before giving up. */
  readonly timeoutMs?: number;
}

export interface MountedWidget {
  readonly host: HTMLElement;
  readonly root: ShadowRoot;
  open(): void;
  close(): void;
  send(text: string): Promise<void>;
}

const HEX = /^#[0-9a-f]{6}$/u;
const SAFE_FONT = /^[A-Za-z0-9 ,'-]{1,60}$/u;
const TENANT = /^[a-z0-9][a-z0-9-]{1,39}$/u;
/** The server keeps the last 16; sending more only spends bytes. */
const HISTORY = 16;
export const MAX_CHARS = 1000;
/** The server cuts earlier replies at 6,000 characters; keeping more in the history only spends bytes. */
export const MAX_REPLY_CHARS = 6000;

export const MESSAGES: Readonly<Record<string, string>> = {
  rate_limited: 'Estás enviando mensajes muy seguido. Espera un minuto e inténtalo de nuevo.',
  busy: 'Hay muchas consultas en este momento. Inténtalo de nuevo en unos minutos.',
  monthly_limit: 'El asistente alcanzó su límite de uso. Contacta al negocio por otro medio.',
  spend_limit: 'El asistente alcanzó su límite de uso por hoy. Contacta al negocio por otro medio.',
  paused: 'El asistente no está disponible. Contacta al negocio por otro medio.',
  origin_not_allowed: 'Este asistente no está habilitado para este sitio.',
  bad_request: 'No se pudo enviar el mensaje. Revisa que no sea demasiado largo.',
  no_answer: 'No pude responder a eso. Prueba con otra pregunta.',
  unavailable: 'El asistente no está disponible en este momento. Inténtalo de nuevo más tarde.',
  network: 'No hay conexión con el asistente. Revisa tu conexión e inténtalo de nuevo.',
};

/** The tenant and the backend's base URL from the script tag, or null if either is unusable. */
export function optionsFromScript(script: HTMLScriptElement): { tenant: string; base: string } | null {
  const tenant = (script.dataset['tenant'] ?? '').trim();
  if (!TENANT.test(tenant)) return null;
  try {
    // Without data-api the backend is the origin that served this file: /embed/chat.js -> /.
    const base = new URL(script.dataset['api'] ?? '../', script.src);
    if (base.protocol !== 'https:' && base.protocol !== 'http:') return null;
    if (!base.pathname.endsWith('/')) base.pathname += '/';
    base.search = '';
    base.hash = '';
    return { tenant, base: base.href };
  } catch {
    return null;
  }
}

export function isPublicConfig(value: unknown): value is PublicConfig {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const text = (x: unknown, max: number): boolean => typeof x === 'string' && x.length > 0 && x.length <= max;
  return (
    text(v['header'], 60) &&
    text(v['welcome'], 300) &&
    text(v['placeholder'], 80) &&
    typeof v['primaryColor'] === 'string' &&
    HEX.test(v['primaryColor']) &&
    typeof v['font'] === 'string' &&
    SAFE_FONT.test(v['font']) &&
    Array.isArray(v['suggestedQuestions']) &&
    v['suggestedQuestions'].length <= 4 &&
    v['suggestedQuestions'].every((q) => text(q, 80))
  );
}

/** WCAG relative luminance of a #rrggbb color. */
function luminance(hex: string): number {
  const channel = (i: number): number => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** White or near-black text on the tenant's color, whichever contrasts more. */
export function textOn(hex: string): string {
  const l = luminance(hex);
  const white = 1.05 / (l + 0.05);
  const dark = (l + 0.05) / (luminance('#111418') + 0.05);
  return white >= dark ? '#ffffff' : '#111418';
}

const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.launcher, .panel { position: fixed; right: 16px; z-index: 2147483000; font-family: var(--cw-font), system-ui, sans-serif; }
.launcher { bottom: 16px; width: 56px; height: 56px; border: 0; border-radius: 50%; background: var(--cw-accent); color: var(--cw-on-accent); cursor: pointer; display: grid; place-items: center; box-shadow: 0 6px 20px rgb(0 0 0 / 0.25); }
.panel { bottom: 84px; width: min(370px, calc(100vw - 32px)); height: min(540px, calc(100vh - 108px)); height: min(540px, calc(100dvh - 108px)); display: flex; flex-direction: column; border-radius: 12px; overflow: hidden; background: var(--cw-bg); color: var(--cw-text); box-shadow: 0 16px 48px rgb(0 0 0 / 0.3); font-size: 15px; line-height: 1.45; }
.panel[hidden] { display: none; }
.head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 12px 12px 12px 16px; background: var(--cw-accent); color: var(--cw-on-accent); }
.title { margin: 0; font-size: 16px; font-weight: 600; }
.close { width: 36px; height: 36px; border: 0; border-radius: 8px; background: transparent; color: inherit; cursor: pointer; display: grid; place-items: center; }
.log { flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 8px; background: var(--cw-log); }
.msg { max-width: 85%; padding: 8px 12px; border-radius: 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
.msg.bot { align-self: flex-start; background: var(--cw-bg); border: 1px solid var(--cw-line); }
.msg.user { align-self: flex-end; background: var(--cw-accent); color: var(--cw-on-accent); }
.msg.error { align-self: flex-start; background: var(--cw-bg); border: 1px solid var(--cw-error); }
.msg.pending { align-self: flex-start; color: var(--cw-muted); font-style: italic; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { border: 1px solid var(--cw-line); background: var(--cw-bg); color: var(--cw-text); border-radius: 999px; padding: 6px 12px; font: inherit; font-size: 14px; cursor: pointer; }
.form { display: flex; gap: 8px; padding: 10px; border-top: 1px solid var(--cw-line); background: var(--cw-bg); }
.input { flex: 1; min-width: 0; border: 1px solid var(--cw-line); border-radius: 8px; padding: 10px 12px; font: inherit; font-size: 16px; color: var(--cw-text); background: var(--cw-bg); }
.send { border: 0; border-radius: 8px; padding: 0 14px; font: inherit; font-weight: 600; background: var(--cw-accent); color: var(--cw-on-accent); cursor: pointer; }
.send:disabled { opacity: 0.6; cursor: progress; }
.sr { position: absolute; width: 1px; height: 1px; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
button:focus-visible, .input:focus-visible { outline: 3px solid var(--cw-focus); outline-offset: 2px; }
.close:focus-visible { outline-color: var(--cw-on-accent); outline-offset: -3px; }
.panel { --cw-bg: #ffffff; --cw-log: #f4f5f7; --cw-text: #16191d; --cw-muted: #5b636e; --cw-line: #cfd4da; --cw-error: #b3261e; --cw-focus: #0b57d0; }
@media (prefers-color-scheme: dark) {
  .panel { --cw-bg: #1b1e23; --cw-log: #121417; --cw-text: #eceff2; --cw-muted: #a7afb9; --cw-line: #3a4048; --cw-error: #f2b8b5; --cw-focus: #a8c7fa; }
}
/* The launcher sits on the host page, whose background is unknown: a ring in the tenant's color, offset from the button. */
.launcher:focus-visible { outline: 3px solid var(--cw-accent); outline-offset: 3px; }
@media (prefers-reduced-motion: no-preference) { .launcher { transition: transform 0.15s; } .launcher:hover { transform: scale(1.05); } }
`;

const SVG = 'http://www.w3.org/2000/svg';

function icon(doc: Document, path: string): SVGSVGElement {
  const svg = doc.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '24');
  svg.setAttribute('height', '24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const p = doc.createElementNS(SVG, 'path');
  p.setAttribute('d', path);
  svg.append(p);
  return svg;
}

function el<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function attachStyles(doc: Document, root: ShadowRoot): void {
  const view = doc.defaultView;
  if (view && 'adoptedStyleSheets' in root && typeof view.CSSStyleSheet === 'function') {
    try {
      const sheet = new view.CSSStyleSheet();
      sheet.replaceSync(CSS);
      root.adoptedStyleSheets = [sheet];
      return;
    } catch {
      // Older engines: fall back to a style element.
    }
  }
  const style = doc.createElement('style');
  style.textContent = CSS;
  root.append(style);
}

async function loadConfig(options: WidgetOptions, fetchFn: typeof fetch): Promise<PublicConfig | null> {
  try {
    const url = new URL('widget/config', options.base);
    url.searchParams.set('tenant', options.tenant);
    const response = await fetchFn(url.href, { method: 'GET', credentials: 'omit', mode: 'cors' });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    return isPublicConfig(body) ? body : null;
  } catch {
    return null;
  }
}

/**
 * Mounts the widget, or returns null and mounts nothing when the config cannot be loaded or fails
 * its checks. An unknown tenant, a paused plan or an unreachable backend leave the host page as it
 * was: a launcher that can only answer with errors would be worse than none.
 */
export async function mountWidget(options: WidgetOptions): Promise<MountedWidget | null> {
  const doc = options.document ?? document;
  const fetchFn = options.fetch ?? fetch.bind(globalThis);
  if (!TENANT.test(options.tenant)) return null;
  if (doc.querySelector(`[data-chat-widget="${options.tenant}"]`)) return null;
  // The host goes into the page before the config request, empty and unstyled, so a second tag for
  // the same tenant that runs while this one waits finds it and stops. Two tags are two copies of
  // this bundle, so a variable in this module would not be shared between them; the DOM is.
  const host = doc.createElement('div');
  host.dataset['chatWidget'] = options.tenant;
  (doc.body ?? doc.documentElement).append(host);
  const config = await loadConfig(options, fetchFn);
  if (!config) {
    host.remove();
    return null;
  }

  const sessionId = options.sessionId ?? crypto.randomUUID();
  const timeoutMs = options.timeoutMs ?? 30_000;
  const history: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  let busy = false;

  // CSSOM, not a style attribute: allowed under a CSP without 'unsafe-inline'.
  host.style.setProperty('--cw-accent', config.primaryColor);
  host.style.setProperty('--cw-on-accent', textOn(config.primaryColor));
  host.style.setProperty('--cw-font', config.font);
  const root = host.attachShadow({ mode: 'open' });
  attachStyles(doc, root);

  const panelId = 'cw-panel';
  const titleId = 'cw-title';
  const launcher = el(doc, 'button', 'launcher');
  launcher.type = 'button';
  launcher.setAttribute('aria-label', 'Abrir chat');
  launcher.setAttribute('aria-expanded', 'false');
  launcher.setAttribute('aria-controls', panelId);
  launcher.append(icon(doc, 'M21 12a8 8 0 0 1-11.6 7.1L4 21l1.9-5.4A8 8 0 1 1 21 12z'));

  const panel = el(doc, 'section', 'panel');
  panel.id = panelId;
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-labelledby', titleId);

  const head = el(doc, 'div', 'head');
  const title = el(doc, 'h2', 'title', config.header);
  title.id = titleId;
  const closeButton = el(doc, 'button', 'close');
  closeButton.type = 'button';
  closeButton.setAttribute('aria-label', 'Cerrar chat');
  closeButton.append(icon(doc, 'M6 6l12 12M18 6L6 18'));
  head.append(title, closeButton);

  const log = el(doc, 'div', 'log');
  log.setAttribute('role', 'log');
  log.setAttribute('aria-live', 'polite');
  log.setAttribute('aria-label', 'Conversación');

  const form = el(doc, 'form', 'form');
  const inputId = 'cw-input';
  const label = el(doc, 'label', 'sr', 'Tu mensaje');
  label.htmlFor = inputId;
  const input = el(doc, 'input', 'input');
  input.id = inputId;
  input.type = 'text';
  input.autocomplete = 'off';
  input.maxLength = MAX_CHARS;
  input.placeholder = config.placeholder;
  const sendButton = el(doc, 'button', 'send', 'Enviar');
  sendButton.type = 'submit';
  form.append(label, input, sendButton);

  panel.append(head, log, form);
  root.append(launcher, panel);

  const scrollDown = (): void => {
    log.scrollTop = log.scrollHeight;
  };
  const bubble = (text: string, kind: 'bot' | 'user' | 'error' | 'pending'): HTMLElement => {
    const node = el(doc, 'p', `msg ${kind}`, text);
    log.append(node);
    scrollDown();
    return node;
  };

  bubble(config.welcome, 'bot');
  if (config.suggestedQuestions.length > 0) {
    const chips = el(doc, 'div', 'chips');
    for (const question of config.suggestedQuestions) {
      const chip = el(doc, 'button', 'chip', question);
      chip.type = 'button';
      chip.addEventListener('click', () => {
        chips.remove();
        void send(question);
      });
      chips.append(chip);
    }
    log.append(chips);
  }

  const open = (): void => {
    panel.hidden = false;
    launcher.setAttribute('aria-expanded', 'true');
    launcher.setAttribute('aria-label', 'Cerrar chat');
    input.focus();
  };
  const close = (): void => {
    panel.hidden = true;
    launcher.setAttribute('aria-expanded', 'false');
    launcher.setAttribute('aria-label', 'Abrir chat');
    launcher.focus();
  };
  launcher.addEventListener('click', () => (panel.hidden ? open() : close()));
  closeButton.addEventListener('click', close);
  // On the shadow root, so Escape also closes the panel while focus is on the launcher.
  root.addEventListener('keydown', (event) => {
    if ('key' in event && event.key === 'Escape' && !panel.hidden) {
      event.preventDefault();
      close();
    }
  });

  async function send(raw: string): Promise<void> {
    const text = raw.trim().slice(0, MAX_CHARS);
    if (text === '' || busy) return;
    busy = true;
    sendButton.disabled = true;
    input.value = '';
    bubble(text, 'user');
    const pending = bubble('Escribiendo…', 'pending');
    pending.setAttribute('aria-hidden', 'true');
    const messages = [...history, { role: 'user' as const, content: text }].slice(-HISTORY);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let shown: { text: string; kind: 'bot' | 'error' };
    try {
      const response = await fetchFn(new URL('widget/chat', options.base).href, {
        method: 'POST',
        credentials: 'omit',
        mode: 'cors',
        // text/plain keeps this a simple request: no preflight, one round trip.
        headers: { 'content-type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify({ tenant: options.tenant, sessionId, messages }),
        signal: controller.signal,
      });
      const body: unknown = await response.json().catch(() => null);
      const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
      const replyText = record['reply'];
      if (response.ok && typeof replyText === 'string' && replyText.trim() !== '') {
        // Only a turn that was answered joins the history, so the next request still alternates.
        history.push({ role: 'user', content: text }, { role: 'assistant', content: replyText.trim().slice(0, MAX_REPLY_CHARS) });
        shown = { text: replyText, kind: 'bot' };
      } else {
        const code = typeof record['error'] === 'string' ? record['error'] : 'unavailable';
        shown = { text: MESSAGES[code] ?? MESSAGES['unavailable'] ?? '', kind: 'error' };
      }
    } catch {
      shown = { text: MESSAGES['network'] ?? '', kind: 'error' };
    } finally {
      clearTimeout(timer);
    }
    // A new node rather than an edit of the pending one: a live region announces additions.
    pending.remove();
    bubble(shown.text, shown.kind);
    busy = false;
    sendButton.disabled = false;
    if (!panel.hidden) input.focus();
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void send(input.value);
  });

  // An async tag in <head> can run before <body> exists; by now it usually does.
  if (doc.body && host.parentNode !== doc.body) doc.body.append(host);
  return { host, root, open, close, send };
}
