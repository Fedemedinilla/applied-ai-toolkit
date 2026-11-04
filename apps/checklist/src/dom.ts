// A small element builder. Text is always added as text nodes (append), never as innerHTML, so an
// evidence note or an imported sentence cannot become markup.

export type Attrs = Readonly<Record<string, string | number | boolean | null | undefined>>;
export type Child = Node | string | null | undefined | false;

export type H = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs, ...children: Child[]) => HTMLElementTagNameMap[K];

export function builder(doc: Document): H {
  return (tag, attrs = {}, ...children) => {
    const el = doc.createElement(tag);
    for (const [name, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      el.setAttribute(name, value === true ? '' : String(value));
    }
    for (const child of children) if (child !== null && child !== undefined && child !== false) el.append(child);
    return el;
  };
}

export function byId<T extends HTMLElement = HTMLElement>(doc: Document, id: string): T {
  const el = doc.getElementById(id);
  if (!el) throw new Error(`#${id} missing from the page`);
  return el as T;
}
