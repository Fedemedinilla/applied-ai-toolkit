// @vitest-environment jsdom
//
// The page in a DOM, against the real index.html: the sample order becomes a PDF with a download
// link, edits rebuild it and never leave a stale link, errors sit next to their fields, warnings
// point at the field they came from, and the rows can be added and removed by keyboard.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument } from 'pdf-lib';
import { mountApp, type App } from '../src/app.ts';

// Paths, not URL objects: under jsdom the global URL is jsdom's, which node:fs does not accept.
const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '../index.html'), 'utf8');
const logo = new Uint8Array(readFileSync(join(here, '../public/logo-ejemplo.png')));

interface Harness {
  app: App;
  blobs: Map<string, Blob>;
  revoked: string[];
}

// Every mounted app is destroyed after its test, so no timer from one test fires into the next
// test's document.
const mounted: App[] = [];
afterEach(() => {
  for (const app of mounted.splice(0)) app.destroy();
});

interface Overrides {
  loadSampleLogo?: () => Promise<Uint8Array | null>;
  readFile?: (file: File) => Promise<Uint8Array>;
}

function mount(overrides: Overrides = {}): Harness {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  document.body.replaceWith(document.importNode(parsed.body, true));
  const blobs = new Map<string, Blob>();
  const revoked: string[] = [];
  let n = 0;
  const app = mountApp(document, {
    createUrl: (blob) => {
      const url = `blob:test/${++n}`;
      blobs.set(url, blob);
      return url;
    },
    revokeUrl: (url) => revoked.push(url),
    loadSampleLogo: overrides.loadSampleLogo ?? (async () => logo),
    readFile: overrides.readFile ?? (async (file) => new Uint8Array(await file.arrayBuffer())),
    today: () => '2026-11-04',
    debounceMs: 5,
  });
  mounted.push(app);
  return { app, blobs, revoked };
}

const $ = <T extends HTMLElement>(selector: string): T => {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`missing ${selector}`);
  return el;
};

function type(selector: string, value: string): void {
  const el = $<HTMLInputElement>(selector);
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

async function pdfOf(h: Harness): Promise<PDFDocument> {
  const href = $<HTMLAnchorElement>('#download').getAttribute('href') ?? '';
  const blob = h.blobs.get(href);
  if (!blob) throw new Error('no PDF behind the link');
  return PDFDocument.load(new Uint8Array(await blob.arrayBuffer()));
}

describe('the receipt page', () => {
  let h: Harness;
  beforeEach(async () => {
    h = mount();
    await h.app.settled();
  });

  it('builds the sample order on load and offers it through a normal download link', async () => {
    const link = $<HTMLAnchorElement>('#download');
    expect(link.getAttribute('href')).toBe('blob:test/1');
    expect(link.download).toBe('remito-R-0042.pdf');
    expect(link.hasAttribute('aria-disabled')).toBe(false);
    expect($<HTMLAnchorElement>('#open').getAttribute('href')).toBe('blob:test/1');
    expect($<HTMLIFrameElement>('#preview').getAttribute('src')).toBe('blob:test/1');
    expect(h.blobs.get('blob:test/1')?.type).toBe('application/pdf');
    expect($('#status').textContent).toMatch(/^Listo: remito-R-0042\.pdf, 1 página, [\d,]+ kB\.$/u);
    const pdf = await pdfOf(h);
    expect(pdf.getTitle()).toBe('REMITO R-0042');
    expect($('#notices').hidden).toBe(true);
  });

  it('shows each row subtotal computed by the library', () => {
    const totals = [...document.querySelectorAll('#items output')].map((o) => o.textContent);
    expect(totals).toEqual(['$25.000', '$20.401,50', '$21.000']);
  });

  it('removes the link while an edit is pending and rebuilds with the new content', async () => {
    type('#customer-name', 'Otro Jardín');
    expect($('#download').hasAttribute('href')).toBe(false);
    expect($('#download').getAttribute('aria-disabled')).toBe('true');
    expect($('#status').textContent).toBe('Actualizando el PDF…');
    await h.app.settled();
    expect($('#download').getAttribute('href')).toBe('blob:test/2');
    expect(h.revoked).toEqual(['blob:test/1']);
  });

  it('puts an error next to its field, links nothing, and focuses it on submit', async () => {
    type('#item-1-price', '6800.50');
    await h.app.settled();
    const price = $<HTMLInputElement>('#item-1-price');
    expect(price.getAttribute('aria-invalid')).toBe('true');
    expect(price.getAttribute('aria-describedby')).toBe('amount-hint item-1-price-error');
    expect($('#item-1-price-error').textContent).toBe('Los centavos van con coma: 8.000,50.');
    expect($('#download').hasAttribute('href')).toBe(false);
    expect($('#status').textContent).toBe('No se generó el PDF: revisa el campo marcado.');

    $<HTMLButtonElement>('button[type="submit"]').click();
    await h.app.settled();
    expect(document.activeElement).toBe(price);

    type('#item-1-price', '6.800,50');
    await h.app.settled();
    expect(price.hasAttribute('aria-invalid')).toBe(false);
    expect(price.getAttribute('aria-describedby')).toBe('amount-hint');
    expect(document.querySelector('.error')).toBeNull();
    expect($('#download').hasAttribute('href')).toBe(true);
  });

  it('builds the hostile sample and lists what changed, each notice linking to its field', async () => {
    $<HTMLButtonElement>('[data-sample="hostile"]').click();
    await h.app.settled();
    expect($('#notices').hidden).toBe(false);
    const notices = [...document.querySelectorAll<HTMLAnchorElement>('#notice-list a')];
    const textOf = notices.map((a) => a.textContent ?? '');
    expect(textOf).toContain('Producto 1, nombre: se quitó un carácter que la fuente del PDF no puede dibujar (emoji u otros alfabetos).');
    expect(textOf).toContain('Producto 4, nombre: no entra completo y se cortó con puntos suspensivos.');
    expect(textOf.some((t) => t.startsWith('Nombre del cliente: se quitó'))).toBe(true);
    const clipped = notices.find((a) => a.textContent?.startsWith('Producto 4, nombre: no entra'));
    clipped?.click();
    expect(document.activeElement?.id).toBe($<HTMLInputElement>('#items li:nth-child(4) input').id);
    expect($('#download').getAttribute('download')).toBe('remito-R-0099.pdf');
  });

  it('builds the 120-line sample across pages', async () => {
    $<HTMLButtonElement>('[data-sample="long"]').click();
    await h.app.settled();
    const pages = (await pdfOf(h)).getPageCount();
    expect(pages).toBeGreaterThan(4);
    expect($('#status').textContent).toContain(`${pages} páginas`);
  });

  it('adds and removes rows with focus where the keyboard user expects it', async () => {
    $<HTMLButtonElement>('#add-item').click();
    const rows = () => [...document.querySelectorAll<HTMLLIElement>('#items li')];
    expect(rows()).toHaveLength(4);
    expect(document.activeElement?.id).toBe('item-3-name');
    expect(rows()[3]?.querySelector('legend')?.textContent).toBe('Producto 4');
    await h.app.settled();
    // A blank added row is not an error and is not printed.
    expect($('#download').hasAttribute('href')).toBe(true);

    rows()[0]?.querySelector<HTMLButtonElement>('button.remove')?.click();
    expect(rows()).toHaveLength(3);
    expect(document.activeElement?.id).toBe('item-1-name');
    expect(rows().map((r) => r.querySelector('legend')?.textContent)).toEqual(['Producto 1', 'Producto 2', 'Producto 3']);
    expect(rows()[0]?.querySelector('button.remove')?.getAttribute('aria-label')).toBe('Quitar producto 1');
    await h.app.settled();
    expect($('#download').hasAttribute('href')).toBe(true);
  });

  it('names a warning after the row number the page shows when an earlier row is blank', async () => {
    // Row 1 cleared is blank and left out of the data, so row 2 is item 0 for the library.
    for (const part of ['name', 'detail', 'price']) type(`#item-0-${part}`, '');
    type('#item-1-name', 'Helecho 🌿');
    await h.app.settled();
    expect($('#items li:nth-child(2) legend').textContent).toBe('Producto 2');
    const notices = [...document.querySelectorAll<HTMLAnchorElement>('#notice-list a')].map((a) => a.textContent);
    expect(notices).toEqual(['Producto 2, nombre: se quitó un carácter que la fuente del PDF no puede dibujar (emoji u otros alfabetos).']);
  });

  it('speaks only when the state changes, while the visible status follows every rebuild', async () => {
    const live = $('#announce');
    expect(live.getAttribute('role')).toBe('status');
    expect($('#status').hasAttribute('role')).toBe(false);
    const first = live.textContent;
    expect(first).toMatch(/^Listo: remito-R-0042\.pdf, 1 página/u);

    type('#customer-name', 'Otro Jardín');
    expect($('#status').textContent).toBe('Actualizando el PDF…');
    expect(live.textContent).toBe(first);
    await h.app.settled();
    expect(live.textContent).toBe(first);

    type('#item-1-price', '6800.50');
    await h.app.settled();
    expect(live.textContent).toBe('No se generó el PDF: revisa el campo marcado.');
    type('#item-1-price', '6.800,50');
    await h.app.settled();
    expect(live.textContent).toMatch(/^Listo:/u);
  });

  it('marks the links as pending in their accessible name while a rebuild waits', async () => {
    const pending = () => [...document.querySelectorAll<HTMLElement>('#result .pending')].map((p) => p.hidden);
    expect(pending()).toEqual([true, true]);
    type('#customer-name', 'Otro Jardín');
    expect($('#download').getAttribute('role')).toBe('link');
    expect($('#download').getAttribute('aria-disabled')).toBe('true');
    expect(pending()).toEqual([false, false]);
    expect($('#download').textContent).toBe('Descargar (se está actualizando)');
    await h.app.settled();
    expect(pending()).toEqual([true, true]);
  });

  it('cancels a scheduled rebuild when destroyed', async () => {
    type('#customer-name', 'Otro Jardín');
    h.app.destroy();
    await new Promise((r) => setTimeout(r, 20));
    expect($('#status').textContent).toBe('Actualizando el PDF…');
    expect(h.revoked).toEqual(['blob:test/1']);
  });

  it('builds without the logo, and with an uploaded one that is not an image it says so', async () => {
    const none = $<HTMLInputElement>('input[name="logo"][value="none"]');
    none.checked = true;
    none.dispatchEvent(new Event('change', { bubbles: true }));
    await h.app.settled();
    expect($('#download').hasAttribute('href')).toBe(true);

    const fileChoice = $<HTMLInputElement>('input[name="logo"][value="file"]');
    fileChoice.checked = true;
    fileChoice.dispatchEvent(new Event('change', { bubbles: true }));
    const input = $<HTMLInputElement>('#logo-file');
    expect(input.hidden).toBe(false);
    expect(document.activeElement).toBe(input);
    Object.defineProperty(input, 'files', { value: [new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' })] });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 20));
    await h.app.settled();
    expect($('#notice-list').textContent).toContain('El logo no es un PNG ni un JPG; se imprimió el nombre del negocio.');
  });
});

describe('a logo that cannot be used', () => {
  it('points the notice at the logo choice in use when the file input is hidden', async () => {
    const h = mount({ loadSampleLogo: async () => new TextEncoder().encode('<!doctype html>') });
    await h.app.settled();
    const link = $<HTMLAnchorElement>('#notice-list a');
    expect(link.textContent).toBe('El logo no es un PNG ni un JPG; se imprimió el nombre del negocio.');
    expect(link.getAttribute('href')).toBe('#logo-sample');
    link.click();
    expect(document.activeElement?.id).toBe('logo-sample');
  });

  it('says so when the uploaded file cannot be read', async () => {
    const h = mount({ readFile: async () => Promise.reject(new Error('unreadable')) });
    await h.app.settled();
    const fileChoice = $<HTMLInputElement>('#logo-upload');
    fileChoice.checked = true;
    fileChoice.dispatchEvent(new Event('change', { bubbles: true }));
    await h.app.settled();
    const input = $<HTMLInputElement>('#logo-file');
    Object.defineProperty(input, 'files', { value: [new File(['x'], 'logo.png', { type: 'image/png' })] });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 20));
    expect($('#status').textContent).toBe('No se pudo leer el archivo del logo.');
    expect($('#announce').textContent).toBe('No se pudo leer el archivo del logo.');
  });
});

describe('when the sample logo cannot be fetched', () => {
  it('still builds the PDF, without a logo', async () => {
    const h = mount({ loadSampleLogo: async () => Promise.reject(new Error('offline')) });
    await h.app.settled();
    expect($('#download').hasAttribute('href')).toBe(true);
    expect($('#status').textContent).toMatch(/^Listo:/u);
  });
});
