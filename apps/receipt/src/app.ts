// The page: an editable order on the left of the screen (or above it on a phone), the PDF built
// from it in this tab, and a normal link to download it. Nothing is sent anywhere.
//
// Every change schedules a rebuild. Until that rebuild lands, the download link has no href, so
// a click never saves a PDF of an order the form no longer shows. Each build has a sequence
// number and a late result for an older one is dropped.
//
// The visible status line changes on every rebuild. The live region next to it speaks only when
// the state changes (an error, a fix, a new page count), so a screen reader does not read the
// whole ready sentence after every pause in typing.

import {
  buildReceipt,
  formatCents,
  lineTotalCents,
  MAX_CENTS,
  ReceiptInputError,
} from '../../../pdf-receipt/src/index.ts';
import { FIELD, toReceipt, type Draft, type DraftItem, type FieldError } from './draft.ts';
import { parseMoney, parseQuantity } from './fields.ts';
import { inputErrorText, warningText, type Located } from './messages.ts';
import { EMPTY_ITEM, hostileOrder, longOrder, simpleOrder } from './samples.ts';

export interface AppDeps {
  /** URL.createObjectURL in the page; a fake in tests, where jsdom has none. */
  readonly createUrl: (blob: Blob) => string;
  readonly revokeUrl: (url: string) => void;
  /** The sample logo's bytes, or null when they cannot be fetched (the PDF then has no logo). */
  readonly loadSampleLogo: () => Promise<Uint8Array | null>;
  readonly readFile: (file: File) => Promise<Uint8Array>;
  /** Today as YYYY-MM-DD in the device's calendar. */
  readonly today: () => string;
  /** Delay between the last edit and the rebuild. */
  readonly debounceMs: number;
}

export interface App {
  /** Builds now and resolves when the page shows the result. */
  readonly generate: () => Promise<void>;
  /** Resolves when no rebuild is scheduled or running. */
  readonly settled: () => Promise<void>;
  /** Cancels a scheduled rebuild, drops one in flight and revokes the current PDF's URL. */
  readonly destroy: () => void;
}

function need<T extends Element>(root: ParentNode, selector: string): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`receipt: missing ${selector} in the markup`);
  return el;
}

const AR_DECIMAL = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 1 });

export function fileNameFor(number: string): string {
  const slug = number
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^A-Za-z0-9-]+/gu, '-')
    .replace(/-{2,}/gu, '-')
    .replace(/^-|-$/gu, '')
    .slice(0, 60);
  return slug ? `remito-${slug}.pdf` : 'remito.pdf';
}

export function mountApp(doc: Document, deps: AppDeps): App {
  const form = need<HTMLFormElement>(doc, '#order');
  const list = need<HTMLOListElement>(doc, '#items');
  const status = need<HTMLElement>(doc, '#status');
  const announcer = need<HTMLElement>(doc, '#announce');
  const download = need<HTMLAnchorElement>(doc, '#download');
  const open = need<HTMLAnchorElement>(doc, '#open');
  const preview = need<HTMLIFrameElement>(doc, '#preview');
  const notices = need<HTMLElement>(doc, '#notices');
  const noticeList = need<HTMLUListElement>(doc, '#notice-list');
  const logoFile = need<HTMLInputElement>(doc, '#logo-file');
  // Looked up inside this form, so an instance can never read the controls of another mount.
  const input = (id: string): HTMLInputElement | HTMLTextAreaElement => need(form, `#${id}`);

  let nextRow = 0;
  let sequence = 0;
  let currentUrl: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> = Promise.resolve();
  let sampleLogo: Promise<Uint8Array | null> | null = null;
  let uploadedLogo: Uint8Array | null = null;
  let destroyed = false;
  /** What the live region last said, as a state key: 'ready:<pages>' or the error text. */
  let announced: string | null = null;

  const announce = (key: string, text: string): void => {
    if (key === announced) return;
    announced = key;
    announcer.textContent = text;
  };
  const fail = (text: string): void => {
    status.textContent = text;
    announce(text, text);
  };

  // ---- Item rows ----

  const rowIds = (): number[] => [...list.querySelectorAll<HTMLLIElement>('li[data-row]')].map((li) => Number(li.dataset['row']));

  const field = (id: string, label: string, value: string, extra: Partial<HTMLInputElement> = {}): HTMLDivElement => {
    const wrap = doc.createElement('div');
    wrap.className = 'field';
    const l = doc.createElement('label');
    l.htmlFor = id;
    l.textContent = label;
    const i = doc.createElement('input');
    i.id = id;
    i.type = 'text';
    i.autocomplete = 'off';
    i.value = value;
    Object.assign(i, extra);
    wrap.append(l, i);
    return wrap;
  };

  const renumber = (): void => {
    list.querySelectorAll<HTMLLIElement>('li[data-row]').forEach((li, i) => {
      need<HTMLLegendElement>(li, 'legend').textContent = `Producto ${i + 1}`;
      need<HTMLButtonElement>(li, 'button.remove').setAttribute('aria-label', `Quitar producto ${i + 1}`);
      need<HTMLOutputElement>(li, 'output').setAttribute('aria-label', `Subtotal del producto ${i + 1}`);
    });
  };

  const updateLineTotal = (li: HTMLLIElement): void => {
    const row = Number(li.dataset['row']);
    const q = parseQuantity(input(FIELD.itemQuantity(row)).value);
    const p = parseMoney(input(FIELD.itemUnitPrice(row)).value, { negative: false });
    const out = need<HTMLOutputElement>(li, 'output');
    out.textContent =
      q.ok && p.ok && p.value !== null && lineTotalCents(q.value, p.value) <= MAX_CENTS
        ? formatCents(lineTotalCents(q.value, p.value), { locale: 'es-AR', symbol: '$' })
        : '';
  };

  const addRow = (item: DraftItem): HTMLLIElement => {
    const row = nextRow++;
    const li = doc.createElement('li');
    li.className = 'item';
    li.dataset['row'] = String(row);
    const set = doc.createElement('fieldset');
    const legend = doc.createElement('legend');
    const grid = doc.createElement('div');
    grid.className = 'item-grid';
    const total = doc.createElement('output');
    total.className = 'line-total';
    const remove = doc.createElement('button');
    remove.type = 'button';
    remove.className = 'remove secondary';
    remove.textContent = 'Quitar';
    remove.addEventListener('click', () => {
      const next = li.nextElementSibling ?? li.previousElementSibling;
      li.remove();
      renumber();
      const focusTarget = next?.querySelector<HTMLInputElement>('input') ?? need<HTMLButtonElement>(doc, '#add-item');
      focusTarget.focus();
      schedule();
    });
    grid.append(
      field(FIELD.itemName(row), 'Nombre', item.name),
      field(FIELD.itemDetail(row), 'Detalle', item.detail),
      field(FIELD.itemQuantity(row), 'Cantidad', item.quantity, { inputMode: 'decimal' }),
      field(FIELD.itemUnitPrice(row), 'Precio unitario', item.unitPrice, { inputMode: 'decimal' }),
    );
    const tail = doc.createElement('div');
    tail.className = 'item-tail';
    tail.append(total, remove);
    set.append(legend, grid, tail);
    li.append(set);
    list.append(li);
    for (const id of [FIELD.itemQuantity(row), FIELD.itemUnitPrice(row)]) {
      need<HTMLInputElement>(li, `#${id}`).setAttribute('aria-describedby', 'amount-hint');
    }
    li.addEventListener('input', () => updateLineTotal(li));
    updateLineTotal(li);
    return li;
  };

  // ---- Reading and filling the form ----

  const read = (): Draft => ({
    number: input(FIELD.number).value,
    issuedOn: input(FIELD.issuedOn).value,
    deliveryOn: input(FIELD.deliveryOn).value,
    shopName: input(FIELD.shopName).value,
    shopLines: input(FIELD.shopLines).value,
    customerName: input(FIELD.customerName).value,
    customerLines: input(FIELD.customerLines).value,
    items: rowIds().map((row) => ({
      name: input(FIELD.itemName(row)).value,
      detail: input(FIELD.itemDetail(row)).value,
      quantity: input(FIELD.itemQuantity(row)).value,
      unitPrice: input(FIELD.itemUnitPrice(row)).value,
    })),
    shipping: input(FIELD.shipping).value,
    balance: input(FIELD.balance).value,
    notes: input(FIELD.notes).value,
    footer: input(FIELD.footer).value,
  });

  const fill = (d: Draft): void => {
    input(FIELD.number).value = d.number;
    input(FIELD.issuedOn).value = d.issuedOn;
    input(FIELD.deliveryOn).value = d.deliveryOn;
    input(FIELD.shopName).value = d.shopName;
    input(FIELD.shopLines).value = d.shopLines;
    input(FIELD.customerName).value = d.customerName;
    input(FIELD.customerLines).value = d.customerLines;
    input(FIELD.shipping).value = d.shipping;
    input(FIELD.balance).value = d.balance;
    input(FIELD.notes).value = d.notes;
    input(FIELD.footer).value = d.footer;
    list.replaceChildren();
    for (const item of d.items) addRow(item);
    renumber();
  };

  // ---- Errors next to their fields ----

  const clearErrors = (): void => {
    for (const p of [...form.querySelectorAll('.error')]) p.remove();
    for (const el of [...form.querySelectorAll<HTMLElement>('[aria-invalid]')]) {
      el.removeAttribute('aria-invalid');
      const original = el.dataset['describedby'];
      if (original === undefined) continue;
      if (original) el.setAttribute('aria-describedby', original);
      else el.removeAttribute('aria-describedby');
      delete el.dataset['describedby'];
    }
  };

  const showError = ({ field: id, message }: FieldError): void => {
    const el = doc.getElementById(id);
    if (!el) return;
    const errorId = `${id}-error`;
    if (doc.getElementById(errorId)) return;
    const p = doc.createElement('p');
    p.id = errorId;
    p.className = 'error';
    p.textContent = message;
    el.after(p);
    const describedBy = el.getAttribute('aria-describedby') ?? '';
    el.dataset['describedby'] = describedBy;
    el.setAttribute('aria-describedby', `${describedBy} ${errorId}`.trim());
    el.setAttribute('aria-invalid', 'true');
  };

  // ---- The result ----

  const pending = [...doc.querySelectorAll<HTMLElement>('#result .pending')];
  const clearLinks = (): void => {
    for (const a of [download, open]) {
      a.removeAttribute('href');
      a.setAttribute('aria-disabled', 'true');
    }
    for (const p of pending) p.hidden = false;
  };

  /** A notice's target, or the logo choice in use when the file input is hidden. */
  const noticeTarget = (id: string): HTMLElement | null => {
    const el = doc.getElementById(id);
    if (el instanceof HTMLInputElement && el.hidden) return form.querySelector<HTMLInputElement>('input[name="logo"]:checked');
    return el;
  };

  const showNotices = (items: readonly Located[]): void => {
    noticeList.replaceChildren(
      ...items.map((n) => {
        const li = doc.createElement('li');
        const target = n.field ? noticeTarget(n.field) : null;
        if (target?.id) {
          const a = doc.createElement('a');
          a.href = `#${target.id}`;
          a.textContent = n.text;
          a.addEventListener('click', (e) => {
            e.preventDefault();
            target.focus();
          });
          li.append(a);
        } else {
          li.textContent = n.text;
        }
        return li;
      }),
    );
    notices.hidden = items.length === 0;
  };

  const logoBytes = async (): Promise<Uint8Array | null> => {
    const choice = form.querySelector<HTMLInputElement>('input[name="logo"]:checked')?.value;
    if (choice === 'sample') return (sampleLogo ??= deps.loadSampleLogo().catch(() => null));
    if (choice === 'file') return uploadedLogo;
    return null;
  };

  const build = async (seq: number, focusOnError: boolean): Promise<void> => {
    try {
      await buildOrThrow(seq, focusOnError);
    } catch {
      // read() or toReceipt() failing would be a bug in this page; the user still gets a message
      // instead of a status stuck on "Actualizando".
      if (seq !== sequence) return;
      clearLinks();
      fail('No se pudo generar el PDF en este navegador.');
    }
  };

  const buildOrThrow = async (seq: number, focusOnError: boolean): Promise<void> => {
    clearErrors();
    const draft = read();
    const result = toReceipt(draft, rowIds());
    if (!result.ok) {
      result.errors.forEach(showError);
      clearLinks();
      showNotices([]);
      const n = result.errors.length;
      fail(`No se generó el PDF: ${n === 1 ? 'revisa el campo marcado' : `revisa los ${n} campos marcados`}.`);
      if (focusOnError) doc.getElementById(result.errors[0]?.field ?? '')?.focus();
      return;
    }
    const logo = await logoBytes();
    if (seq !== sequence) return;
    let built;
    try {
      built = await buildReceipt(result.data, { logo });
    } catch (e) {
      if (seq !== sequence) return;
      clearLinks();
      if (e instanceof ReceiptInputError) {
        const located = inputErrorText(e, result.rows);
        if (located.field) showError({ field: located.field, message: located.text });
        fail(`No se generó el PDF: ${located.text}`);
      } else {
        fail('No se pudo generar el PDF en este navegador.');
      }
      return;
    }
    if (seq !== sequence) return;

    const url = deps.createUrl(new Blob([built.bytes], { type: 'application/pdf' }));
    const name = fileNameFor(draft.number);
    download.href = url;
    download.download = name;
    open.href = url;
    for (const a of [download, open]) a.removeAttribute('aria-disabled');
    for (const p of pending) p.hidden = true;
    preview.src = url;
    if (currentUrl) deps.revokeUrl(currentUrl);
    currentUrl = url;
    showNotices(built.warnings.map((w) => warningText(w, result.rows)));
    const pages = built.pageCount === 1 ? '1 página' : `${built.pageCount} páginas`;
    const ready = `Listo: ${name}, ${pages}, ${AR_DECIMAL.format(built.bytes.length / 1000)} kB.`;
    status.textContent = ready;
    announce(`ready:${built.pageCount}`, ready);
  };

  const generate = (focusOnError = false): Promise<void> => {
    if (destroyed) return Promise.resolve();
    if (timer) clearTimeout(timer);
    timer = null;
    const seq = ++sequence;
    running = build(seq, focusOnError);
    return running;
  };

  const schedule = (): void => {
    if (destroyed) return;
    clearLinks();
    status.textContent = 'Actualizando el PDF…';
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void generate(), deps.debounceMs);
  };

  // ---- Events ----

  form.addEventListener('input', (e) => {
    if (e.target === logoFile) return;
    schedule();
  });
  form.addEventListener('change', (e) => {
    const target = e.target;
    if (target instanceof HTMLInputElement && target.name === 'logo') {
      logoFile.hidden = target.value !== 'file';
      if (target.value === 'file' && !uploadedLogo) logoFile.focus();
      schedule();
    }
  });
  logoFile.addEventListener('change', () => {
    const file = logoFile.files?.[0];
    if (!file) return;
    clearLinks();
    deps.readFile(file).then(
      (bytes) => {
        uploadedLogo = bytes;
        schedule();
      },
      () => fail('No se pudo leer el archivo del logo.'),
    );
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void generate(true);
  });
  need<HTMLButtonElement>(doc, '#add-item').addEventListener('click', () => {
    const li = addRow(EMPTY_ITEM);
    renumber();
    li.querySelector<HTMLInputElement>('input')?.focus();
    schedule();
  });
  for (const button of doc.querySelectorAll<HTMLButtonElement>('[data-sample]')) {
    button.addEventListener('click', () => {
      const today = deps.today();
      const kind = button.dataset['sample'];
      fill(kind === 'hostile' ? hostileOrder(today) : kind === 'long' ? longOrder(today) : simpleOrder(today));
      void generate();
    });
  }

  fill(simpleOrder(deps.today()));
  void generate();

  return {
    generate: () => generate(true),
    settled: async () => {
      while (timer !== null) await new Promise((r) => setTimeout(r, deps.debounceMs + 1));
      await running;
    },
    destroy: () => {
      destroyed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      sequence++;
      if (currentUrl) deps.revokeUrl(currentUrl);
      currentUrl = null;
    },
  };
}
