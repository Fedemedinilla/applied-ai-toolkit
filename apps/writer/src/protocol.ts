// The two-turn protocol between the server and the model, as plain text markers:
//
//   turn 1 (titles)  [[TITULOS]]\nA: ...\nB: ...\nC: ...\n[[/TITULOS]]
//   turn 2 (draft)   [[COMUNICADO]]\n<Spanish body>\n[[EN]]\n<English body>\n[[/COMUNICADO]]
//
// [[EN]] appears only for bilingual categories. Facts the user did not give are written as
// [COMPLETAR: what is missing], which the code lists and the page highlights.
//
// Markers instead of structured output: the parser accepts a complete block and drops anything
// around it, the protocol needs no schema per category, and the page shows the draft as written,
// with no JSON layer to decode. Structured output was not tried. The parser is strict about
// structure and forgiving about whitespace: a block without its closing marker is not a block,
// and a titles block with fewer than two usable titles is not a titles block.
//
// Pure and browser-safe: the server parses replies with it, and the page uses the placeholder
// pattern to highlight.

export const TITLES_OPEN = '[[TITULOS]]';
export const TITLES_CLOSE = '[[/TITULOS]]';
export const DRAFT_OPEN = '[[COMUNICADO]]';
export const DRAFT_CLOSE = '[[/COMUNICADO]]';
export const EN_SPLIT = '[[EN]]';

/**
 * brief, titles, pick, draft, then three rounds of changes (each a request and a new draft):
 * a request is at most 9 messages long, ending on the third change. The server refuses longer ones.
 */
export const MAX_MESSAGES = 9;

export const MIN_TITLES = 2;
export const MAX_TITLES = 5;
export const MAX_TITLE_CHARS = 120;

/** [COMPLETAR: ...] with what is missing inside. A bare [COMPLETAR] also counts, with an empty label. */
export const PLACEHOLDER = /\[COMPLETAR(?::\s*([^\]\n]{0,160}))?\]/gu;

export type Reply =
  | { readonly kind: 'titles'; readonly titles: readonly string[] }
  | { readonly kind: 'draft'; readonly es: string; readonly en: string | null }
  /** Anything else: a reply with no complete block. The text is shown as is. */
  | { readonly kind: 'text'; readonly text: string };

/** The content between the first `open` and the first `close` after it, or null. */
function between(text: string, open: string, close: string): string | null {
  const start = text.indexOf(open);
  if (start === -1) return null;
  const end = text.indexOf(close, start + open.length);
  if (end === -1) return null;
  return text.slice(start + open.length, end);
}

/** One title per line: "A: ...", "1. ...", "- ..." or bare. Quotes and bold markers are dropped. */
export function parseTitles(block: string): string[] {
  const seen = new Set<string>();
  const titles: string[] = [];
  for (const raw of block.split('\n')) {
    const line = raw
      .trim()
      .replace(/^(?:[A-Ea-e][:.)]|\d[.)]|[-*•])\s*/u, '')
      .replace(/^\*\*(.*)\*\*$/u, '$1')
      .replace(/^["“«](.*)["”»]$/u, '$1')
      .trim();
    if (line === '' || line.length > MAX_TITLE_CHARS) continue;
    const key = line.toLocaleLowerCase('es');
    if (seen.has(key)) continue;
    seen.add(key);
    titles.push(line);
  }
  return titles.slice(0, MAX_TITLES);
}

/**
 * Reads one model reply. A complete draft block wins over a titles block, since a model that
 * skipped ahead to the draft has still done the job. Text outside the blocks is dropped: the
 * prompt asks for none, and it is never part of what the user copies.
 */
export function parseReply(text: string): Reply {
  const draft = between(text, DRAFT_OPEN, DRAFT_CLOSE);
  if (draft !== null) {
    const parts = draft.split(EN_SPLIT);
    const es = (parts[0] ?? '').trim();
    const en = parts.length > 1 ? parts.slice(1).join('\n').trim() : null;
    if (es !== '') return { kind: 'draft', es, en: en === '' ? null : en };
  }
  const titles = between(text, TITLES_OPEN, TITLES_CLOSE);
  if (titles !== null) {
    const list = parseTitles(titles);
    if (list.length >= MIN_TITLES) return { kind: 'titles', titles: list };
  }
  const stripped = [TITLES_OPEN, TITLES_CLOSE, DRAFT_OPEN, DRAFT_CLOSE, EN_SPLIT].reduce((t, m) => t.split(m).join(''), text).trim();
  return { kind: 'text', text: stripped };
}

/**
 * The reply as it goes back into the history: rebuilt from what was parsed, so the next turn
 * sees one clean block and none of the text the parser dropped.
 */
export function serializeReply(reply: Reply): string {
  switch (reply.kind) {
    case 'titles':
      return [TITLES_OPEN, ...reply.titles.map((t, i) => `${String.fromCharCode(65 + i)}: ${t}`), TITLES_CLOSE].join('\n');
    case 'draft':
      return [DRAFT_OPEN, reply.es, ...(reply.en === null ? [] : [EN_SPLIT, reply.en]), DRAFT_CLOSE].join('\n');
    case 'text':
      return reply.text;
  }
}

/** The labels of every [COMPLETAR: ...] in order, duplicates kept once. */
export function placeholders(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(PLACEHOLDER)) {
    const label = (m[1] ?? '').trim();
    if (!out.includes(label)) out.push(label);
  }
  return out;
}

/** The user turn that picks a title. The server reads only the role sequence, not this wording. */
export const chooseTitleMessage = (title: string): string => `Título elegido: ${title}`;

/**
 * Whether an assistant turn sent back by the page is one this server could have returned at that
 * position: canonical (it rebuilds to itself) and of a kind that fits. Titles come only as the
 * first reply; a draft can be the first reply too, since a model may skip ahead. The page only
 * ever sends back the server's `assistant` strings, so anything else was written by hand.
 */
export function isServedAssistantTurn(content: string, index: number): boolean {
  const reply = parseReply(content);
  if (serializeReply(reply) !== content) return false;
  if (reply.kind === 'text') return reply.text !== '';
  if (reply.kind === 'titles') return index === 1;
  return true;
}
