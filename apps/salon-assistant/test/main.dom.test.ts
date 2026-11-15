// @vitest-environment jsdom
//
// The browser entry over the real index.html, with a stubbed fetch: what the live region reads out
// for a reply with a card.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../index.html'), 'utf8');

const reply = {
  reply: 'Te lo paso como pedido.\n\n- Llegá cinco minutos antes.\n- Traé el pelo seco.',
  signature: 'sig',
  booking: { service: 'Corte', price: 16_000, minutes: 30, stylist: null, candidates: ['Ana', 'Bea'], dayLabel: 'sábado 7', time: null },
};

beforeAll(async () => {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  document.body.replaceWith(document.importNode(parsed.body, true));
  Element.prototype.scrollIntoView = () => {};
  vi.stubGlobal('fetch', async (input: string) =>
    input === './api/health'
      ? new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
      : new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } }),
  );
  await import('../src/main.ts');
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('the live region', () => {
  it('reads the reply and the card with a pause between blocks, labels and values', async () => {
    const text = document.querySelector<HTMLTextAreaElement>('#text')!;
    const announce = document.querySelector<HTMLElement>('#announce')!;
    text.value = 'un corte el sábado';
    document.querySelector<HTMLFormElement>('#form')!.requestSubmit();
    for (let i = 0; i < 100 && !announce.textContent; i++) await new Promise((r) => setTimeout(r, 5));
    expect(announce.textContent).toBe(
      'Te lo paso como pedido. Llegá cinco minutos antes. Traé el pelo seco. ' +
        'Pedido de turno (lo confirma el local). Servicio: Corte. Precio: $16.000. Duración: 30 min. Día: sábado 7. Hora: a convenir. Con: Ana o Bea.',
    );
  });
});
