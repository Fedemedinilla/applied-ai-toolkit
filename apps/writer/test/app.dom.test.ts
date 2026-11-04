// @vitest-environment jsdom
//
// The page in a DOM, against the real index.html markup and a scripted server: pick a role and a
// category, ask for titles, choose one, read the draft and its checks, copy, revise.

import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lengthRequest, mountApp } from '../src/app.ts';
import type { ClipboardPort } from '../src/clipboard.ts';
import { clientCatalog } from '../src/config-schema.ts';
import { MAX_MESSAGES } from '../src/protocol.ts';
import type { CopyContent } from '../src/format.ts';
import { realConfig } from './raw-config.ts';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '../index.html'), 'utf8');
const catalog = clientCatalog(realConfig());

type Answer = { status: number; body: unknown } | 'network' | 'hang';

interface Harness {
  sent: Array<{ role: string; category: string; messages: Array<{ role: string; content: string }> }>;
  copied: CopyContent[];
  plain: string[];
  queue: Answer[];
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function mount(options: { health?: number; clipboard?: Partial<ClipboardPort> | 'none'; timeoutMs?: number } = {}): Harness {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  document.body.replaceWith(document.importNode(parsed.body, true));
  const harness: Harness = { sent: [], copied: [], plain: [], queue: [] };
  const clipboard: ClipboardPort =
    options.clipboard === 'none'
      ? {}
      : {
          writeRich: async (c) => {
            harness.copied.push(c);
          },
          writeText: async (t) => {
            harness.plain.push(t);
          },
          ...options.clipboard,
        };
  mountApp(document, {
    catalog,
    clipboard,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    fetch: async (input, init) => {
      if (input.endsWith('/api/health')) return new Response('{}', { status: options.health ?? 200 });
      harness.sent.push(JSON.parse(String(init?.body)) as Harness['sent'][number]);
      const next = harness.queue.shift();
      if (next === undefined) throw new Error('unexpected request');
      if (next === 'network') throw new TypeError('Failed to fetch');
      if (next === 'hang') {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        });
      }
      return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'content-type': 'application/json' } });
    },
  });
  return harness;
}

const $ = <T extends HTMLElement = HTMLElement>(selector: string): T => {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`missing ${selector}`);
  return el;
};
const status = () => $('#status').textContent ?? '';

function pick(name: string, value: string): void {
  const input = $<HTMLInputElement>(`input[name="${name}"][value="${value}"]`);
  input.checked = true;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

const TITLES = { type: 'titles', step: 'titles', titles: ['Reunión de 3.º grado', 'Proyecto de huerta'], assistant: '[[TITULOS]]\nA: Reunión de 3.º grado\nB: Proyecto de huerta\n[[/TITULOS]]' };

function draftBody(es: string, lengthStatus: 'ok' | 'long' = 'ok', extra: Record<string, unknown> = {}) {
  return {
    type: 'draft',
    step: 'draft',
    es,
    en: null,
    report: {
      lengths: [{ lang: 'es', chars: lengthStatus === 'ok' ? 520 : 1320, min: 400, max: 900, status: lengthStatus }],
      placeholders: ['hora'],
      notes: [
        { code: 'placeholders', level: 'warn', text: 'Falta 1 dato antes de enviar: hora.' },
        { code: 'cta', level: 'info', text: 'Agregar la confirmación de asistencia en la plataforma escolar antes de enviar.' },
      ],
    },
    assistant: `[[COMUNICADO]]\n${es}\n[[/COMUNICADO]]`,
    ...extra,
  };
}

const ES = 'Estimadas familias:\n\nReunión el **jueves 12 a las [COMPLETAR: hora]**.\n\n- uno\n- dos\n- tres\n\nEquipo docente de 3.º grado';

async function toDraft(h: Harness, body = draftBody(ES)): Promise<void> {
  pick('role', 'docente');
  pick('category', 'reunion-familias');
  $<HTMLTextAreaElement>('#brief').value = 'Reunión de familias de 3.º grado el jueves 12.';
  h.queue.push({ status: 200, body: TITLES });
  $<HTMLFormElement>('#setup').requestSubmit();
  await settle();
  h.queue.push({ status: 200, body });
  $<HTMLFormElement>('#titles-form').requestSubmit();
  await settle();
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('choosing who writes and what', () => {
  it('lists every role, and only the categories the chosen role writes', async () => {
    mount();
    await settle();
    expect($('#school-name').textContent).toBe('Colegio Bilingüe Monte Lirio');
    expect([...document.querySelectorAll('input[name="role"]')].map((i) => (i as HTMLInputElement).value)).toEqual(['direccion', 'coordinacion', 'docente', 'administracion']);
    expect(document.querySelectorAll('input[name="category"]')).toHaveLength(0);
    pick('role', 'administracion');
    expect([...document.querySelectorAll('input[name="category"]')].map((i) => (i as HTMLInputElement).value)).toEqual(['aviso-general', 'cambio-horario', 'pagos']);
    pick('role', 'direccion');
    expect(document.querySelectorAll('input[name="category"]')).toHaveLength(7);
  });

  it('describes the chosen category from the catalog, with its sensitivity', async () => {
    mount();
    pick('role', 'direccion');
    pick('category', 'situacion-sensible');
    expect($('#category-info').textContent).toBe(
      'Informar un incidente o una situación delicada que afecta a la comunidad. Extensión: 300 a 900 caracteres. Se envía en español. Sensibilidad crítica',
    );
    pick('category', 'evento');
    expect($('#category-info').textContent).toContain('Se envía en español y en inglés.');
  });

  it('every chip is a labelled radio button, so arrows and Tab work without script', () => {
    mount();
    pick('role', 'docente');
    for (const input of document.querySelectorAll<HTMLInputElement>('input[type="radio"]')) {
      expect(document.querySelector(`label[for="${input.id}"]`)?.textContent).not.toBe('');
    }
  });

  it('says what is missing instead of sending', async () => {
    const h = mount();
    await settle();
    $<HTMLFormElement>('#setup').requestSubmit();
    expect(status()).toBe('Falta elegir quién escribe.');
    pick('role', 'docente');
    $<HTMLFormElement>('#setup').requestSubmit();
    expect(status()).toBe('Falta elegir el tipo de comunicado.');
    pick('category', 'aviso-general');
    $<HTMLFormElement>('#setup').requestSubmit();
    expect(status()).toBe('Falta el pedido: qué hay que comunicar.');
    expect(h.sent).toHaveLength(0);
  });
});

describe('the two turns', () => {
  it('sends only ids and the brief, then the chosen title with the server text for the titles', async () => {
    const h = mount();
    await settle();
    await toDraft(h);
    expect(h.sent[0]).toEqual({ role: 'docente', category: 'reunion-familias', messages: [{ role: 'user', content: 'Reunión de familias de 3.º grado el jueves 12.' }] });
    expect(h.sent[1]?.messages).toEqual([
      { role: 'user', content: 'Reunión de familias de 3.º grado el jueves 12.' },
      { role: 'assistant', content: TITLES.assistant },
      { role: 'user', content: 'Título elegido: Reunión de 3.º grado' },
    ]);
  });

  it('shows the titles as a radio group with the first one chosen, and moves focus there', async () => {
    const h = mount();
    await settle();
    pick('role', 'docente');
    pick('category', 'reunion-familias');
    $<HTMLTextAreaElement>('#brief').value = 'Reunión.';
    h.queue.push({ status: 200, body: TITLES });
    $<HTMLFormElement>('#setup').requestSubmit();
    await settle();
    expect($('#titles').hidden).toBe(false);
    expect([...document.querySelectorAll<HTMLInputElement>('input[name="title"]')].map((i) => [i.value, i.checked])).toEqual([
      ['Reunión de 3.º grado', true],
      ['Proyecto de huerta', false],
    ]);
    expect(document.activeElement).toBe($('#titles-heading'));
    expect(status()).toBe('2 títulos propuestos. Elegir uno para redactar.');
  });

  it('renders the draft as text nodes, with gaps marked, lengths and notes', async () => {
    const h = mount();
    await settle();
    await toDraft(h);
    expect($('#draft').hidden).toBe(false);
    expect($('#titles').hidden).toBe(true);
    expect($('#draft-title').textContent).toBe('Reunión de 3.º grado');
    expect($('#draft-es strong').textContent).toBe('jueves 12 a las [COMPLETAR: hora]');
    expect($('#draft-es mark.gap').textContent).toBe('[COMPLETAR: hora]');
    expect(document.querySelectorAll('#draft-es li')).toHaveLength(3);
    expect($('#draft-en-wrap').hidden).toBe(true);
    expect($('#lengths').textContent).toBe('Español: 520 caracteres (rango 400 a 900), dentro del rango.');
    expect([...document.querySelectorAll('#notes li')].map((li) => li.textContent)).toEqual([
      'Revisar: Falta 1 dato antes de enviar: hora.',
      'Recordatorio: Agregar la confirmación de asistencia en la plataforma escolar antes de enviar.',
    ]);
    expect($<HTMLButtonElement>('#fix-length').hidden).toBe(true);
    expect(status()).toBe('Borrador listo, con 1 punto para revisar.');
  });

  it('never parses model text as markup', async () => {
    const h = mount();
    await settle();
    await toDraft(h, draftBody('<img src=x onerror="alert(1)"> Texto'));
    expect(document.querySelector('#draft-es img')).toBeNull();
    expect($('#draft-es').textContent).toBe('<img src=x onerror="alert(1)"> Texto');
  });

  it('shows an English version when the server sends one', async () => {
    const h = mount();
    await settle();
    await toDraft(h, draftBody(ES, 'ok', { en: 'Dear families,\n\nMeeting on Thursday.' }));
    expect($('#draft-en-wrap').hidden).toBe(false);
    expect($('#draft-en').textContent).toBe('Dear families,Meeting on Thursday.');
  });
});

describe('copy', () => {
  it('writes HTML and plain text in one item and says how many gaps are left', async () => {
    const h = mount();
    await settle();
    await toDraft(h);
    $<HTMLButtonElement>('#copy').click();
    await settle();
    expect(h.copied).toHaveLength(1);
    expect(h.copied[0]?.html.startsWith('<p><strong>Reunión de 3.º grado</strong></p><p>Estimadas familias:</p>')).toBe(true);
    expect(h.copied[0]?.plain.startsWith('Reunión de 3.º grado\n\nEstimadas familias:\n\nReunión el jueves 12 a las [COMPLETAR: hora].')).toBe(true);
    expect(status()).toBe('Copiado con formato. Queda 1 dato por completar.');
  });

  it('falls back to plain text when the rich write is refused, and says so when nothing works', async () => {
    const h = mount({
      clipboard: {
        writeRich: async () => {
          throw new Error('NotAllowedError');
        },
      },
    });
    await settle();
    await toDraft(h);
    $<HTMLButtonElement>('#copy').click();
    await settle();
    expect(h.plain).toHaveLength(1);
    expect(status()).toMatch(/^Copiado como texto sin formato\./u);

    const none = mount({ clipboard: 'none' });
    await settle();
    await toDraft(none);
    $<HTMLButtonElement>('#copy').click();
    await settle();
    expect(status()).toBe('El navegador no permitió copiar. Seleccionar el texto y copiarlo a mano.');
  });
});

describe('changes', () => {
  it('offers a length fix with the numbers measured in code, sent as the next user turn', async () => {
    const h = mount();
    await settle();
    await toDraft(h, draftBody(ES, 'long'));
    expect($('#fix-length').hidden).toBe(false);
    h.queue.push({ status: 200, body: { ...draftBody(ES), step: 'revise' } });
    $<HTMLButtonElement>('#fix-length').click();
    await settle();
    expect(h.sent[2]?.messages.at(-1)).toEqual({
      role: 'user',
      content: 'Ajustar la extensión: el texto en español tiene 1.320 caracteres y la categoría pide entre 400 y 900. Llevarlo a ese rango sin quitar datos ni marcas [COMPLETAR].',
    });
    expect($('#fix-length').hidden).toBe(true);
  });

  it('allows three rounds of changes, then says why on the hint and on a click', async () => {
    const h = mount();
    await settle();
    await toDraft(h);
    const hint = $('#revise-hint').textContent;
    for (const change of ['Más breve.', 'Sin la lista.', 'Más formal.']) {
      $<HTMLInputElement>('#revise').value = change;
      h.queue.push({ status: 200, body: draftBody(ES) });
      $<HTMLButtonElement>('#send-revision').click();
      await settle();
    }
    expect(h.sent.map((s) => s.messages.length)).toEqual([1, 3, 5, 7, 9]);
    expect(h.sent.at(-1)?.messages.length).toBe(MAX_MESSAGES);
    // The button stays enabled, so a click (or Enter in the box) reaches the handler.
    expect($<HTMLButtonElement>('#send-revision').disabled).toBe(false);
    expect($('#revise-hint').textContent).toBe('Este borrador llegó al límite de cambios. Para seguir, empieza uno nuevo.');
    $<HTMLInputElement>('#revise').value = 'Otro cambio.';
    $<HTMLButtonElement>('#send-revision').click();
    expect(status()).toBe('Este borrador llegó al límite de cambios. Para seguir, empieza uno nuevo.');
    expect(h.sent).toHaveLength(5);
    $<HTMLButtonElement>('#restart').click();
    expect($('#revise-hint').textContent).toBe(hint);
  });

  it('a draft on the first turn gets the category name as its title', async () => {
    const h = mount();
    await settle();
    pick('role', 'docente');
    pick('category', 'reunion-familias');
    $<HTMLTextAreaElement>('#brief').value = 'Reunión de familias de 3.º grado.';
    h.queue.push({ status: 200, body: draftBody(ES) });
    $<HTMLButtonElement>('#ask-titles').click();
    await settle();
    const name = catalog.categories.find((c) => c.id === 'reunion-familias')?.name;
    expect(name).toBeTruthy();
    expect($('#draft-title').textContent).toBe(name);
    expect(document.activeElement).toBe($('#draft-title'));
    $<HTMLButtonElement>('#copy').click();
    await settle();
    expect(h.copied[0]?.html.startsWith(`<p><strong>${name}</strong></p>`)).toBe(true);
    expect(h.copied[0]?.plain.startsWith(`${name}\n\nEstimadas familias:`)).toBe(true);
  });

  it('lengthRequest is null when every language is in range', () => {
    expect(lengthRequest([{ lang: 'es', chars: 500, min: 400, max: 900, status: 'ok' }])).toBeNull();
  });
});

describe('failures', () => {
  it('turns each error code into its message and keeps the history as it was', async () => {
    const h = mount();
    await settle();
    pick('role', 'docente');
    pick('category', 'reunion-familias');
    $<HTMLTextAreaElement>('#brief').value = 'Reunión.';
    for (const [answer, text] of [
      [{ status: 503, body: { error: 'cap_reached' } }, 'Se alcanzó el límite de uso de este mes. El servicio vuelve el mes próximo.'],
      [{ status: 502, body: { error: 'model_unusable' } }, 'La respuesta no se pudo usar. Intenta de nuevo.'],
      [{ status: 500, body: 'not json' }, 'Hubo un error en el servidor. Intenta de nuevo.'],
      [{ status: 200, body: { type: 'titles', titles: 'no' } }, 'El servidor respondió algo que esta página no reconoce.'],
      ['network', 'No hay conexión con el servidor.'],
    ] as const) {
      h.queue.push(answer);
      $<HTMLFormElement>('#setup').requestSubmit();
      await settle();
      expect(status()).toBe(text);
      expect($('#titles').hidden).toBe(true);
    }
    expect(h.sent.every((s) => s.messages.length === 1)).toBe(true);
  });

  it('gives up after its own deadline', async () => {
    const h = mount({ timeoutMs: 5 });
    await settle();
    pick('role', 'docente');
    pick('category', 'reunion-familias');
    $<HTMLTextAreaElement>('#brief').value = 'Reunión.';
    h.queue.push('hang');
    $<HTMLFormElement>('#setup').requestSubmit();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(status()).toBe('El servicio tardó demasiado en responder. Intenta de nuevo.');
  });

  it('drops a late answer after the user changes the category', async () => {
    const h = mount();
    await settle();
    pick('role', 'docente');
    pick('category', 'reunion-familias');
    $<HTMLTextAreaElement>('#brief').value = 'Reunión.';
    h.queue.push('hang');
    $<HTMLFormElement>('#setup').requestSubmit();
    await settle();
    pick('category', 'aviso-general');
    await settle();
    expect($('#titles').hidden).toBe(true);
    expect(status()).toBe('Se canceló el pedido en curso.');
    expect($<HTMLButtonElement>('#ask-titles').disabled).toBe(false);
  });

  it('without a server, says so and keeps the buttons off', async () => {
    mount({ health: 404 });
    await settle();
    await settle();
    expect($('#service').hidden).toBe(false);
    expect($('#service').textContent).toMatch(/^El servicio de redacción no está disponible/u);
    expect($<HTMLButtonElement>('#ask-titles').disabled).toBe(true);
  });
});
