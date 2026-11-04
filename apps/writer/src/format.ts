// The draft as the page shows it and as the clipboard carries it. The model's text never becomes
// markup by itself: the page builds nodes from these segments, and the HTML for the clipboard is
// built here with every character of the text escaped.
//
// The format is the small one the prompt allows: paragraphs split by blank lines, "- " list
// items, **bold**, and [COMPLETAR: ...] gaps.

import { PLACEHOLDER } from './protocol.ts';

export interface Segment {
  readonly text: string;
  readonly bold: boolean;
  /** A [COMPLETAR: ...] gap, kept with its brackets so a copied text still shows it. */
  readonly gap: boolean;
}

export type Block = { readonly kind: 'paragraph'; readonly lines: readonly Segment[][] } | { readonly kind: 'list'; readonly items: readonly Segment[][] };

/** Splits one line into plain, bold and gap segments. An unpaired ** is kept as text. */
export function segments(line: string): Segment[] {
  const out: Segment[] = [];
  const bolds = line.split(/(\*\*[^*\n]+?\*\*)/u);
  for (const part of bolds) {
    if (part === '') continue;
    const bold = part.length > 4 && part.startsWith('**') && part.endsWith('**');
    const inner = bold ? part.slice(2, -2) : part;
    let last = 0;
    for (const m of inner.matchAll(new RegExp(PLACEHOLDER.source, 'gu'))) {
      const at = m.index;
      if (at > last) out.push({ text: inner.slice(last, at), bold, gap: false });
      out.push({ text: m[0], bold, gap: true });
      last = at + m[0].length;
    }
    if (last < inner.length) out.push({ text: inner.slice(last), bold, gap: false });
  }
  return out;
}

/** Paragraphs and lists, in order. Consecutive "- " lines form one list. */
export function blocks(text: string): Block[] {
  const out: Block[] = [];
  for (const chunk of text.trim().split(/\n\s*\n/u)) {
    let paragraph: Segment[][] = [];
    let list: Segment[][] = [];
    const flush = () => {
      if (paragraph.length) out.push({ kind: 'paragraph', lines: paragraph });
      if (list.length) out.push({ kind: 'list', items: list });
      paragraph = [];
      list = [];
    };
    for (const raw of chunk.split('\n')) {
      const line = raw.trimEnd();
      if (line.trim() === '') continue;
      if (/^\s*- /u.test(line)) {
        if (paragraph.length) flush();
        list.push(segments(line.replace(/^\s*- /u, '')));
      } else {
        if (list.length) flush();
        paragraph.push(segments(line));
      }
    }
    flush();
  }
  return out;
}

const escapeHtml = (s: string): string => s.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;');

const segmentsHtml = (segs: readonly Segment[]): string =>
  segs.map((s) => (s.bold ? `<strong>${escapeHtml(s.text)}</strong>` : escapeHtml(s.text))).join('');

export function textToHtml(text: string): string {
  return blocks(text)
    .map((b) =>
      b.kind === 'paragraph'
        ? `<p>${b.lines.map(segmentsHtml).join('<br>')}</p>`
        : `<ul>${b.items.map((i) => `<li>${segmentsHtml(i)}</li>`).join('')}</ul>`,
    )
    .join('');
}

export function textToPlain(text: string): string {
  return blocks(text)
    .map((b) =>
      b.kind === 'paragraph'
        ? b.lines.map((l) => l.map((s) => s.text).join('')).join('\n')
        : b.items.map((i) => `- ${i.map((s) => s.text).join('')}`).join('\n'),
    )
    .join('\n\n');
}

export interface CopyContent {
  readonly html: string;
  readonly plain: string;
}

/** Title, Spanish text and, for a bilingual category, the English text, as an editor pastes them. */
export function copyContent(title: string, es: string, en: string | null): CopyContent {
  const head = title.trim() === '' ? [] : [title];
  const html = [...head.map((t) => `<p><strong>${escapeHtml(t)}</strong></p>`), textToHtml(es), ...(en === null ? [] : ['<hr>', textToHtml(en)])].join('');
  const plain = [...head, textToPlain(es), ...(en === null ? [] : [textToPlain(en)])].join('\n\n');
  return { html, plain };
}
