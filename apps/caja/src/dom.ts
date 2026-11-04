// DOM helpers shared by the tabs. Owner text only ever reaches the page as a text node: h()
// appends strings with append(), which never parses markup.

import type { SpanRole } from '../../../amount-parser/src/index.ts';
import { segments } from './format.ts';

type Props = Record<string, string | boolean | undefined>;

/** A small element builder. Attributes are set one by one and children are text nodes or elements. */
export function h(tag: string, props: Props = {}, ...children: Array<Node | string | null>): HTMLElement {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === false) continue;
    if (key === 'class') el.className = String(value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children) if (child !== null) el.append(child);
  return el;
}

export function need<T extends HTMLElement>(root: ParentNode, selector: string): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`caja: missing ${selector} in the markup`);
  return el;
}

const ROLE_LABEL: Record<SpanRole, string> = {
  amount: 'monto',
  quantity: 'cantidad',
  unit_price: 'precio por unidad',
  added: 'se suma',
  subtracted: 'se resta',
  figure: 'cifra',
};

export function sentenceView(text: string, spans: Parameters<typeof segments>[1]): HTMLElement {
  const p = h('p', { class: 'sentence' });
  for (const seg of segments(text, spans)) {
    p.append(seg.role ? h('mark', { 'data-role': seg.role, title: ROLE_LABEL[seg.role] }, seg.text) : seg.text);
  }
  return p;
}

export function fact(term: string, ...value: Array<Node | string | null>): HTMLElement {
  return h('div', {}, h('dt', {}, term), h('dd', {}, ...value));
}
