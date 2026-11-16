// The edits of design 4.4 in code: an edit is placed by its exact quote inside its sentence or
// rejected, overlaps and keep[] phrases are refused, accepted edits apply right to left, one edit
// can be reverted alone, and the diff comes from the accepted edits. Every text is fictional:
// Valeria Sosa Pereyra is the fictional CV of evals/cases/cv/es-rioplatense.md.
import { describe, expect, it } from 'vitest';
import { type AppliedEdit, applyEdits, diffHunks, renderEdits, revertEdit, splitSentences } from '../src/edits.ts';
import { DiffHunk, type Edit } from '../src/types.ts';

const TEXT = [
  'Hola Marta,',
  '',
  'Te escribo por la propuesta del 3/11. Me gustaría mucho poder trabajar con ustedes en el sitio.',
  'El formulario con Supabase recibe unos 40 pedidos por semana.',
  '',
  'Saludos,',
  'Valeria',
].join('\n');
const SENTENCES = splitSentences(TEXT, 'es');
const edit = (sentenceId: number, before: string, after: string, extra: Partial<Edit> = {}): Edit => ({
  sentenceId, before, after, reason: 'test', ...extra,
});

describe('applyEdits', () => {
  it('applies the accepted edits and keeps their spans in the original coordinates', () => {
    const result = applyEdits(TEXT, SENTENCES, [
      edit(1, 'Te escribo por', 'Sigo con'),
      edit(2, 'Me gustaría mucho poder trabajar', 'Quiero trabajar'),
    ]);
    expect(result.rejected).toEqual([]);
    expect(result.text).toBe(TEXT.replace('Te escribo por', 'Sigo con').replace('Me gustaría mucho poder trabajar', 'Quiero trabajar'));
    for (const a of result.accepted) expect(TEXT.slice(a.span.start, a.span.end)).toBe(a.before);
    for (const a of result.accepted) expect(result.text.slice(a.newSpan.start, a.newSpan.end)).toBe(a.after);
    expect(result.accepted.map((a) => a.id)).toEqual(['e1', 'e2']);
  });

  it('rejects an edit whose before is not quoted exactly from its sentence', () => {
    const result = applyEdits(TEXT, SENTENCES, [
      edit(1, 'te escribo por', 'Sigo con'), // case differs
      edit(1, 'Te  escribo por', 'Sigo con'), // spacing differs
      edit(2, 'Te escribo por', 'Sigo con'), // right words, wrong sentence
      edit(9, 'Hola', 'Buen día'), // no such sentence
    ]);
    expect(result.text).toBe(TEXT);
    expect(result.accepted).toEqual([]);
    expect(result.rejected.map((r) => r.reason)).toEqual(['not-found', 'not-found', 'not-found', 'not-found']);
    expect(result.rejected[3]?.message).toMatch(/sentence 9/);
  });

  it('rejects an edit whose before appears more than once in its sentence', () => {
    const text = 'Rehice el sitio y el sitio carga en 1,6 s.';
    const result = applyEdits(text, splitSentences(text, 'es'), [edit(0, 'el sitio', 'la página')]);
    expect(result.rejected.map((r) => r.reason)).toEqual(['ambiguous']);
    expect(result.text).toBe(text);
  });

  it('keeps the first of two overlapping edits and rejects the later one', () => {
    const result = applyEdits(TEXT, SENTENCES, [
      edit(2, 'Me gustaría mucho', 'Quiero'),
      edit(2, 'mucho poder trabajar', 'trabajar'),
      edit(2, 'Me gustaría', 'Quisiera'), // inside the first
    ]);
    expect(result.accepted.map((a) => a.id)).toEqual(['e1']);
    expect(result.rejected.map((r) => [r.id, r.reason, r.conflictsWith])).toEqual([
      ['e2', 'overlap', 'e1'],
      ['e3', 'overlap', 'e1'],
    ]);
    expect(result.text).toContain('Quiero poder trabajar');
  });

  it('accepts two edits that touch without overlapping', () => {
    const result = applyEdits(TEXT, SENTENCES, [edit(1, 'Te escribo', 'Sigo'), edit(1, ' por', ' con')]);
    expect(result.rejected).toEqual([]);
    expect(result.text).toContain('Sigo con la propuesta');
  });

  it('rejects an edit that touches a keep[] phrase, anywhere in the phrase', () => {
    const keep = ['unos 40 pedidos por semana'];
    const result = applyEdits(TEXT, SENTENCES, [
      edit(3, 'recibe unos 40', 'recibe 40'),
      edit(3, 'semana', 'semana hábil'),
      edit(3, 'El formulario con Supabase', 'El formulario'),
    ], { keep });
    expect(result.rejected.map((r) => [r.id, r.reason])).toEqual([['e1', 'keep'], ['e2', 'keep']]);
    expect(result.accepted.map((a) => a.id)).toEqual(['e3']);
  });

  it('rejects an edit that changes nothing', () => {
    const result = applyEdits(TEXT, SENTENCES, [edit(1, 'Te escribo', 'Te escribo')]);
    expect(result.rejected.map((r) => r.reason)).toEqual(['no-op']);
  });

  it('numbers the edits with a prefix, so two rounds of edits do not share ids', () => {
    const result = applyEdits(TEXT, SENTENCES, [edit(1, 'Te escribo por', 'Sigo con')], { idPrefix: 'style-' });
    expect(result.accepted.map((a) => a.id)).toEqual(['style-1']);
  });

  it('refuses sentences that were not cut from this text', () => {
    expect(() => applyEdits(`${TEXT} `.replace('Hola', 'Hello'), SENTENCES, [])).toThrow(/sentence 0/);
  });
});

describe('applyEdits on characters made of several code units', () => {
  const apply = (text: string, edits: Edit[], options = {}) => applyEdits(text, splitSentences(text, 'es'), edits, options);

  it('rejects a quote that splits an emoji, a flag or a letter with its accent', () => {
    const emoji = apply('Hola 😀 mundo.', [edit(0, '\uD83D', 'X')]);
    expect(emoji.rejected.map((r) => r.reason)).toEqual(['boundary']);
    expect(emoji.text).toBe('Hola 😀 mundo.');
    expect(apply('Vamos 🇦🇷 hoy.', [edit(0, '\uD83C\uDDE6', 'X')]).rejected.map((r) => r.reason)).toEqual(['boundary']);
    // A letter with a combining mark that has no precomposed form stays one character.
    expect(apply('Uso la ñ\u0301 rara.', [edit(0, 'ñ', 'n')]).rejected.map((r) => r.reason)).toEqual(['boundary']);
    for (const r of [emoji]) expect(r.text.isWellFormed()).toBe(true);
  });

  it('places a quote the same way whatever its normalization, and refuses a text that is not NFC', () => {
    const nfc = 'Vamos al café hoy.';
    const result = apply(nfc, [edit(0, 'café'.normalize('NFD'), 'bar'.normalize('NFD'))]);
    expect(result.rejected).toEqual([]);
    expect(result.text).toBe('Vamos al bar hoy.');
    expect(result.accepted[0]?.before).toBe('café');
    const nfd = nfc.normalize('NFD');
    expect(() => applyEdits(nfd, splitSentences(nfd, 'es'), [edit(0, 'cafe', 'bar')])).toThrow(/NFC/);
  });
});

describe('keep[] phrases', () => {
  const apply = (text: string, edits: Edit[], keep: string[]) => applyEdits(text, splitSentences(text, 'es'), edits, { keep });

  it('protects a phrase the text writes with a line break or other spacing', () => {
    expect(apply('Uso Power\nBI todos los días.', [edit(1, 'BI', 'Tableau')], ['Power BI']).rejected.map((r) => r.reason)).toEqual(['keep']);
    expect(apply('Uso Power  BI todos los días.', [edit(0, 'BI', 'Tableau')], ['Power BI']).rejected.map((r) => r.reason)).toEqual(['keep']);
  });

  it('protects a phrase given in another normalization', () => {
    const text = 'Trabajo con José Pérez.';
    expect(apply(text, [edit(0, 'Pérez', 'Gómez')], ['José Pérez'.normalize('NFD')]).rejected.map((r) => r.reason)).toEqual(['keep']);
  });

  it('rejects an edit at the edge of a phrase that would glue text onto it, and accepts one that keeps it a word', () => {
    const text = 'Uso Power BI mucho.';
    expect(apply(text, [edit(0, ' mucho', 'X mucho')], ['Power BI']).rejected.map((r) => r.reason)).toEqual(['keep']);
    expect(apply(text, [edit(0, 'Uso ', 'Uso')], ['Power BI']).rejected.map((r) => r.reason)).toEqual(['keep']);
    const fine = apply(text, [edit(0, ' mucho', ' bastante'), edit(0, 'Uso ', 'Uso el ')], ['Power BI']);
    expect(fine.rejected).toEqual([]);
    expect(fine.text).toBe('Uso el Power BI bastante.');
  });

  it('ignores an empty or blank keep phrase instead of matching everywhere', () => {
    const result = apply('Uso Power BI mucho.', [edit(0, 'mucho', 'bastante')], ['', '  ']);
    expect(result.rejected).toEqual([]);
    expect(result.text).toBe('Uso Power BI bastante.');
  });
});

describe('render refuses overlapping accepted edits', () => {
  it('throws in revertEdit, renderEdits and diffHunks when two accepted edits overlap', () => {
    const { accepted } = applyEdits(TEXT, SENTENCES, [edit(1, 'Te escribo por', 'Sigo con')]);
    const first = accepted[0] as AppliedEdit;
    const clash: AppliedEdit = { ...first, id: 'x1', span: { start: first.span.start + 3, end: first.span.start + 10 }, before: TEXT.slice(first.span.start + 3, first.span.start + 10) };
    expect(() => renderEdits(TEXT, [first, clash])).toThrow(/overlap/);
    expect(() => diffHunks(TEXT, [first, clash])).toThrow(/overlap/);
    expect(() => revertEdit(TEXT, [first, clash, { ...first, id: 'x2' }], 'x2')).toThrow(/overlap/);
  });
});

describe('revertEdit and renderEdits', () => {
  it('reverts one edit alone and re-derives the text from the original', () => {
    const { accepted } = applyEdits(TEXT, SENTENCES, [
      edit(1, 'Te escribo por', 'Sigo con'),
      edit(2, 'Me gustaría mucho poder trabajar', 'Quiero trabajar'),
    ]);
    const reverted = revertEdit(TEXT, accepted, 'e1');
    expect(reverted.reverted?.id).toBe('e1');
    expect(reverted.accepted.map((a) => a.id)).toEqual(['e2']);
    expect(reverted.text).toBe(TEXT.replace('Me gustaría mucho poder trabajar', 'Quiero trabajar'));
    expect(reverted.text.slice(reverted.accepted[0]?.newSpan.start, reverted.accepted[0]?.newSpan.end)).toBe('Quiero trabajar');
  });

  it('leaves the text as it was for an unknown id', () => {
    const { accepted, text } = applyEdits(TEXT, SENTENCES, [edit(1, 'Te escribo por', 'Sigo con')]);
    const reverted = revertEdit(TEXT, accepted, 'e9');
    expect(reverted.reverted).toBeUndefined();
    expect(reverted.text).toBe(text);
  });
});

describe('diffHunks', () => {
  it('builds one hunk per accepted edit, in the original coordinates, matching the schema', () => {
    const { accepted } = applyEdits(TEXT, SENTENCES, [
      edit(2, 'Me gustaría mucho poder trabajar', 'Quiero trabajar'),
      edit(1, 'Te escribo por', 'Sigo con'),
    ]);
    const hunks = diffHunks(TEXT, accepted);
    expect(hunks.map((h) => [h.before, h.after])).toEqual([
      ['Te escribo por', 'Sigo con'],
      ['Me gustaría mucho poder trabajar', 'Quiero trabajar'],
    ]);
    for (const h of hunks) {
      expect(DiffHunk.parse(h)).toEqual(h);
      expect(TEXT.slice(h.span.start, h.span.end)).toBe(h.before);
    }
  });

  it('refuses edits whose before no longer matches the original', () => {
    const { accepted } = applyEdits(TEXT, SENTENCES, [edit(1, 'Te escribo por', 'Sigo con')]);
    expect(() => diffHunks(TEXT.replace('Te escribo', 'Le escribo'), accepted)).toThrow(/e1/);
  });
});

/** mulberry32: a small seeded generator, so every property run is reproducible from its seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const shuffle = <T>(list: readonly T[], next: () => number): T[] => {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
};

const REPLACEMENTS = ['', 'x', 'otra cosa', 'Sigo con', '3/11', ' y '];

/** Up to one non-overlapping, unambiguous edit per sentence, at a random place. */
function randomEdits(next: () => number): Edit[] {
  const edits: Edit[] = [];
  for (const s of SENTENCES) {
    if (next() < 0.3) continue;
    for (let tries = 0; tries < 10; tries++) {
      const from = Math.floor(next() * s.text.length);
      const to = from + 1 + Math.floor(next() * Math.min(12, s.text.length - from));
      const before = s.text.slice(from, to);
      if (s.text.indexOf(before) !== s.text.lastIndexOf(before)) continue;
      const after = REPLACEMENTS[Math.floor(next() * REPLACEMENTS.length)] ?? '';
      if (after === before) continue;
      edits.push(edit(s.id, before, after));
      break;
    }
  }
  return edits;
}

const bySpan = (list: readonly AppliedEdit[]) => list.map((a) => [a.span.start, a.before, a.after]);

describe('properties over random edits', () => {
  it('reverting every accepted edit, one at a time in any order, returns the original', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const next = rng(seed);
      const result = applyEdits(TEXT, SENTENCES, randomEdits(next));
      expect(result.rejected, `seed ${seed}`).toEqual([]);
      let { accepted, text } = result;
      for (const id of shuffle(accepted.map((a) => a.id), next)) {
        ({ accepted, text } = revertEdit(TEXT, accepted, id));
        expect(text, `seed ${seed}`).toBe(renderEdits(TEXT, accepted));
      }
      expect(text, `seed ${seed}`).toBe(TEXT);
    }
  });

  it('undoing every edit in the rewritten text, by its new span, returns the original', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const { accepted, text } = applyEdits(TEXT, SENTENCES, randomEdits(rng(seed)));
      let undone = text;
      for (const a of [...accepted].sort((x, y) => y.newSpan.start - x.newSpan.start)) {
        expect(undone.slice(a.newSpan.start, a.newSpan.end), `seed ${seed}`).toBe(a.after);
        undone = undone.slice(0, a.newSpan.start) + a.before + undone.slice(a.newSpan.end);
      }
      expect(undone, `seed ${seed}`).toBe(TEXT);
    }
  });

  it('non-overlapping edits commute: any order gives the same text, edits and diff', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const next = rng(seed);
      const edits = randomEdits(next);
      const a = applyEdits(TEXT, SENTENCES, edits);
      const b = applyEdits(TEXT, SENTENCES, shuffle(edits, next));
      expect(b.text, `seed ${seed}`).toBe(a.text);
      expect(bySpan(b.accepted), `seed ${seed}`).toEqual(bySpan(a.accepted));
      expect(diffHunks(TEXT, b.accepted), `seed ${seed}`).toEqual(diffHunks(TEXT, a.accepted));
    }
  });
});
