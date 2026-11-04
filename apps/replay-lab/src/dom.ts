// Element helpers. Text always goes in as text nodes; nothing here sets innerHTML.

type Child = Node | string | number | null | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  attrs: Readonly<Record<string, string>> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = doc.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
  for (const child of children) if (child !== null && child !== false) el.append(typeof child === 'number' ? String(child) : child);
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export function s(doc: Document, tag: string, attrs: Readonly<Record<string, string | number>> = {}, ...children: Child[]): SVGElement {
  const el = doc.createElementNS(SVG_NS, tag) as SVGElement;
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, String(value));
  for (const child of children) if (child !== null && child !== false) el.append(typeof child === 'number' ? String(child) : child);
  return el;
}

export function byId<T extends HTMLElement = HTMLElement>(doc: Document, id: string): T {
  const el = doc.getElementById(id);
  if (!el) throw new Error(`replay-lab: #${id} is missing from index.html`);
  return el as T;
}
