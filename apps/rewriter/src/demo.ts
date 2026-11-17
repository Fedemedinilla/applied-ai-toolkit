// The demo: real rewrites recorded from the model on fictional eval cases (demo/examples.json,
// built by scripts/demo-examples.ts), served next to the page and fetched only when the page has
// no server behind it. Nothing is sent and no model is called. The file is checked here by hand
// for the shape the page reads, and by test/demo.test.ts against prose-rewriter's schema.

import { GENRES, LANGS, MODES, VARIETIES, type Genre, type Lang, type Mode, type Variety } from './protocol.ts';
import { asResult, type Result } from './result.ts';

export const EXAMPLES_URL = './examples.json';

export interface DemoInput {
  readonly text: string;
  readonly genre: Genre;
  readonly lang: Lang;
  readonly variety?: Variety | undefined;
  readonly mode: Mode;
  readonly recipient?: { readonly name?: string; readonly org?: string; readonly role?: string; readonly previousMessage?: string } | undefined;
  readonly keep?: readonly string[] | undefined;
}

export interface DemoExample {
  readonly id: string;
  readonly title: string;
  readonly note: string;
  readonly input: DemoInput;
  readonly result: Result;
}

export interface DemoSet {
  readonly fictional: string;
  /** The day the run that produced them was made, YYYY-MM-DD. */
  readonly recorded: string;
  readonly examples: readonly DemoExample[];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === 'string';
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => (list as readonly unknown[]).includes(v);
const optionalString = (v: unknown): boolean => v === undefined || isString(v);

function asInput(v: unknown): DemoInput | null {
  if (!isObject(v) || !isString(v['text']) || !oneOf(GENRES, v['genre']) || !oneOf(LANGS, v['lang']) || !oneOf(MODES, v['mode'])) return null;
  if (v['variety'] !== undefined && !oneOf(VARIETIES, v['variety'])) return null;
  const r = v['recipient'];
  if (r !== undefined && !(isObject(r) && ['name', 'org', 'role', 'previousMessage'].every((k) => optionalString(r[k])))) return null;
  const keep = v['keep'];
  if (keep !== undefined && !(Array.isArray(keep) && keep.every(isString))) return null;
  return {
    text: v['text'],
    genre: v['genre'],
    lang: v['lang'],
    mode: v['mode'],
    variety: v['variety'] as Variety | undefined,
    recipient: r as DemoInput['recipient'],
    keep: keep as string[] | undefined,
  };
}

/** The demo set, or null when the file does not have the shape the page reads. */
export function asDemoSet(v: unknown): DemoSet | null {
  if (!isObject(v) || !isString(v['fictional']) || !v['fictional'].startsWith('Fictional') || !isString(v['recorded']) || !Array.isArray(v['examples'])) return null;
  const examples: DemoExample[] = [];
  for (const e of v['examples']) {
    if (!isObject(e) || !isString(e['id']) || !isString(e['title']) || !isString(e['note'])) return null;
    const input = asInput(e['input']);
    const result = asResult(e['result']);
    if (input === null || result === null) return null;
    examples.push({ id: e['id'], title: e['title'], note: e['note'], input, result });
  }
  return examples.length === 0 ? null : { fictional: v['fictional'], recorded: v['recorded'], examples };
}
