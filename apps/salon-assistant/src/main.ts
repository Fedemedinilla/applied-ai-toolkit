// The chat page. It keeps the conversation in memory, sends it whole on every turn with the
// signature the server gave each reply, and renders replies with safe-markdown: the model's text
// is escaped before any formatting and no link leaves the page.

import { renderMarkdown } from '../../../safe-markdown/src/index.ts';

interface Card {
  service: string;
  price: number;
  minutes: number;
  stylist: string | null;
  candidates: string[] | null;
  dayLabel: string;
  time: string | null;
}
interface Turn {
  role: 'user' | 'assistant';
  content: string;
  signature?: string;
}

const ERRORS: Record<string, string> = {
  busy: 'El asistente está ocupado. Prueba de nuevo en un momento.',
  limited: 'Demasiados mensajes seguidos. Espera un minuto.',
  unavailable: 'El asistente no está disponible ahora.',
  turn_limit: 'Esta conversación llegó a su límite. Empieza de nuevo.',
  history: 'La conversación no se pudo verificar. Empieza de nuevo.',
};

const log = document.querySelector<HTMLOListElement>('#log');
const form = document.querySelector<HTMLFormElement>('#form');
const text = document.querySelector<HTMLTextAreaElement>('#text');
const status = document.querySelector<HTMLParagraphElement>('#status');
const reset = document.querySelector<HTMLButtonElement>('#reset');
const announce = document.querySelector<HTMLElement>('#announce');
const button = form?.querySelector<HTMLButtonElement>('button[type="submit"]') ?? null;
let turns: Turn[] = [];
// One turn at a time. requestSubmit() ignores a disabled submit button, so Enter could otherwise
// start a second request from the same `turns`, and the later reply would drop the other exchange.
let pending = false;

const money = (n: number) => `$${n.toLocaleString('es-AR')}`;

function cardView(card: Card): HTMLElement {
  const box = document.createElement('div');
  box.className = 'card';
  const title = document.createElement('strong');
  title.textContent = 'Pedido de turno (lo confirma el local)';
  const dl = document.createElement('dl');
  const who = card.stylist ?? (card.candidates ?? []).join(' o ');
  const rows: Array<[string, string]> = [
    ['Servicio', card.service],
    ['Precio', money(card.price)],
    ['Duración', `${card.minutes} min`],
    ['Día', card.dayLabel],
    ['Hora', card.time ?? 'a convenir'],
    ['Con', who],
  ];
  for (const [k, v] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    dl.append(dt, dd);
  }
  box.append(title, dl);
  return box;
}

function add(role: Turn['role'], content: string, card: Card | null = null): HTMLLIElement {
  const li = document.createElement('li');
  li.className = role === 'user' ? 'me' : 'bot';
  if (role === 'user') li.textContent = content;
  else li.innerHTML = renderMarkdown(content, { internalHosts: [], externalHosts: [], mailto: false });
  if (card) li.append(cardView(card));
  log?.append(li);
  li.scrollIntoView({ block: 'nearest' });
  // Only replies are announced, through their own live region: a live log would read the
  // visitor's own message back to them.
  if (role === 'assistant' && announce) announce.textContent = li.textContent ?? '';
  return li;
}

/** The visitor's bubble for a turn that did not go through, and its text back in the box. */
function unsent(li: HTMLLIElement, content: string): void {
  li.classList.add('failed');
  li.append(' (no enviado)');
  if (text && !text.value) text.value = content;
}

function isReply(x: unknown): x is { reply: string; signature: string; booking: Card | null } {
  if (typeof x !== 'object' || x === null) return false;
  const r = x as Record<string, unknown>;
  return typeof r['reply'] === 'string' && typeof r['signature'] === 'string' && (r['booking'] === null || typeof r['booking'] === 'object');
}

async function send(content: string): Promise<void> {
  const sent: Turn[] = [...turns, { role: 'user', content }];
  const mine = add('user', content);
  if (status) status.textContent = 'Escribiendo…';
  if (button) button.disabled = true;
  try {
    const res = await fetch('./api/assistant', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: sent }) });
    const data: unknown = await res.json().catch(() => null);
    if (isReply(data)) {
      turns = [...sent, { role: 'assistant', content: data.reply, signature: data.signature }];
      add('assistant', data.reply, data.booking);
      if (status) status.textContent = '';
    } else {
      // A failed turn is not part of the conversation: the next send starts from `turns` again.
      const code = typeof data === 'object' && data !== null ? String((data as Record<string, unknown>)['error']) : '';
      if (status) status.textContent = ERRORS[code] ?? 'No se pudo enviar. Prueba de nuevo.';
      unsent(mine, content);
    }
  } catch {
    if (status) status.textContent = 'Sin conexión. Prueba de nuevo.';
    unsent(mine, content);
  } finally {
    pending = false;
    if (button) button.disabled = false;
    text?.focus();
  }
}

form?.addEventListener('submit', (e) => {
  e.preventDefault();
  if (pending) return;
  const value = text?.value.trim() ?? '';
  if (!value) return;
  if (text) text.value = '';
  pending = true;
  void send(value);
});
text?.addEventListener('keydown', (e) => {
  // isComposing: Enter that confirms an IME composition is not a send.
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    form?.requestSubmit();
  }
});
reset?.addEventListener('click', () => {
  if (pending) return;
  turns = [];
  if (log) log.textContent = '';
  if (status) status.textContent = '';
  text?.focus();
});

// The missing-key notice only for the server's own answer (503 with {ok:false}); a network error
// or a proxy's 5xx is not a missing key.
void fetch('./api/health')
  .then(async (r): Promise<'ok' | 'no_key' | 'down'> => {
    if (r.ok) return 'ok';
    const data: unknown = await r.json().catch(() => null);
    const noKey = r.status === 503 && typeof data === 'object' && data !== null && (data as Record<string, unknown>)['ok'] === false;
    return noKey ? 'no_key' : 'down';
  })
  .catch(() => 'down' as const)
  .then((state) => {
    const note = document.querySelector<HTMLElement>('#unavailable');
    if (!note) return;
    note.hidden = state === 'ok';
    if (state === 'down') note.textContent = 'No se pudo conectar con el asistente.';
  });
