// The edits of design 4.4 in code: an edit is placed by its exact quote inside its sentence or
// rejected, overlaps and keep[] phrases are refused, accepted edits apply right to left, one edit
// can be reverted alone, and the diff comes from the accepted edits. Every text is fictional:
// Valeria Sosa Pereyra is the fictional CV of evals/cases/cv/es-rioplatense.md.
import { describe, expect, it } from 'vitest';
import { type AppliedEdit, applyEdits, diffHunks, renderEdits, revertEdit, splitSentences, tidyDeletions } from '../src/edits.ts';
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

// The live eval of 17/11 shipped "Hola Martín,\n\n Te escribo..." (es-email-heavy and 25 other
// pieces): the model deletes a sentence by quoting it without the space after it, so the space
// stays at the start of the paragraph, or doubles up between two sentences.
describe('tidyDeletions', () => {
  const tidyText = (text: string, edits: readonly Edit[]): string =>
    renderEdits(text, tidyDeletions(text, applyEdits(text, splitSentences(text, 'es'), edits).accepted));

  it('takes the space after a sentence deleted at the start of a paragraph, so the paragraph does not start with a space', () => {
    const text = 'Hola Martín,\n\nEspero que estés bien. Te escribo por el sitio.\n\nSaludos,\nValeria';
    expect(tidyText(text, [edit(1, 'Espero que estés bien.', '')])).toBe('Hola Martín,\n\nTe escribo por el sitio.\n\nSaludos,\nValeria');
  });

  it('leaves one space where a sentence between two others is deleted, and no space at the end of a line', () => {
    const text = 'Hola Marta,\n\nTe escribo por el sitio. Me apasiona la web. Lo armé en Astro.\nAvisame.';
    const ids = (q: string): number => splitSentences(text, 'es').findIndex((s) => s.text === q);
    expect(tidyText(text, [edit(ids('Me apasiona la web.'), 'Me apasiona la web.', '')])).toBe('Hola Marta,\n\nTe escribo por el sitio. Lo armé en Astro.\nAvisame.');
    expect(tidyText(text, [edit(ids('Lo armé en Astro.'), 'Lo armé en Astro.', '')])).toBe('Hola Marta,\n\nTe escribo por el sitio. Me apasiona la web.\nAvisame.');
  });

  it('tidies two deleted sentences in a row the same way whatever order they came in', () => {
    const text = 'Hola Marta,\n\nEspero que estés bien. Me apasiona la web. Te escribo por el sitio.';
    const ids = (q: string): number => splitSentences(text, 'es').findIndex((s) => s.text === q);
    const both = [edit(ids('Espero que estés bien.'), 'Espero que estés bien.', ''), edit(ids('Me apasiona la web.'), 'Me apasiona la web.', '')];
    expect(tidyText(text, both)).toBe('Hola Marta,\n\nTe escribo por el sitio.');
    expect(tidyText(text, [...both].reverse())).toBe('Hola Marta,\n\nTe escribo por el sitio.');
  });

  it('takes the space before a run of deleted sentences that closes a line (en-cover-letter-heavy-3, live run 17/11)', () => {
    const text = 'Hi Marcus,\n\nI am applying for the role. Every team starts with a ticket. That ticket changed everything.\n\nBest,\nDaniel';
    const ids = (q: string): number => splitSentences(text, 'en').findIndex((s) => s.text === q);
    const both = [edit(ids('Every team starts with a ticket.'), 'Every team starts with a ticket.', ''), edit(ids('That ticket changed everything.'), 'That ticket changed everything.', '')];
    const tidy = (list: readonly Edit[]): string => renderEdits(text, tidyDeletions(text, applyEdits(text, splitSentences(text, 'en'), list).accepted));
    expect(tidy(both)).toBe('Hi Marcus,\n\nI am applying for the role.\n\nBest,\nDaniel');
    expect(tidy([...both].reverse())).toBe('Hi Marcus,\n\nI am applying for the role.\n\nBest,\nDaniel');
  });

  it('never glues two words: a deleted word between letters and punctuation keeps its neighbours apart', () => {
    const text = 'Uso Astro mucho, y también Supabase.';
    expect(tidyText(text, [edit(0, 'mucho', '')])).toBe('Uso Astro, y también Supabase.');
    expect(tidyText(text, [edit(0, 'Astr', '')])).toBe('Uso o mucho, y también Supabase.');
  });

  // Review of 17/11: the page lets the user restore any single change, so each deletion of a run
  // must take its own space. Restoring one of two deleted sentences must neither glue two
  // sentences ("Hola.Tres") nor leave a space at the end or start of a line. A run that fills a
  // whole line is left out: its two deletions share one space, which only one of them can hold.
  it('widens each deletion of a run on its own, so restoring any one of them leaves clean text', () => {
    const shapes: { text: string; quotes: string[] }[] = [
      { text: 'Hola. Uno dos. Tres cuatro.\nChau.', quotes: ['Uno dos.', 'Tres cuatro.'] },
      { text: 'Uno dos. Tres cuatro. Cinco.\nChau.', quotes: ['Uno dos.', 'Tres cuatro.'] },
      { text: 'Hola. Uno dos. Tres cuatro. Cinco.', quotes: ['Uno dos.', 'Tres cuatro.'] },
      { text: 'Hola.\n\nUno dos. Tres cuatro. Cinco.\n\nChau.', quotes: ['Tres cuatro.', 'Cinco.'] },
      { text: '(Uno dos. Tres cuatro.) Cinco.', quotes: ['Uno dos.'] },
      { text: 'Hola. Uno. Dos. Tres.\nChau.', quotes: ['Uno.', 'Dos.', 'Tres.'] },
    ];
    for (const { text, quotes } of shapes) {
      const units = splitSentences(text, 'es');
      const edits = quotes.map((q) => edit(units.findIndex((s) => s.text === q), q, ''));
      const tidy = tidyDeletions(text, applyEdits(text, units, edits).accepted);
      for (let keep = 0; keep < 1 << tidy.length; keep++) {
        // Bit i set: the user keeps deletion i; unset: they restore it.
        let out = text;
        for (const [i, a] of [...tidy.entries()].reverse()) if ((keep >> i) & 1) out = out.slice(0, a.span.start) + a.after + out.slice(a.span.end);
        const label = `${JSON.stringify(text)} keep=${keep.toString(2)}`;
        expect(out, label).not.toMatch(/[.!?][^\s.!?)]/u);
        expect(out, label).not.toMatch(/(?:^|\n)[ \t]|[ \t](?:\n|$)| {2}/u);
      }
    }
  });

  it('keeps every span in the original and the diff applying to the tidy text, and tidying twice changes nothing', () => {
    for (let seed = 1; seed <= 200; seed++) {
      // Half the runs delete what each random edit quotes, so most edits are deletions.
      const edits = randomEdits(rng(seed)).map((e) => (seed % 2 === 0 ? { ...e, after: '' } : e));
      const { accepted } = applyEdits(TEXT, SENTENCES, edits);
      const tidy = tidyDeletions(TEXT, accepted);
      const text = renderEdits(TEXT, tidy);
      for (const a of tidy) expect(TEXT.slice(a.span.start, a.span.end), `seed ${seed}`).toBe(a.before);
      let applied = TEXT;
      for (const h of [...diffHunks(TEXT, tidy)].reverse()) applied = applied.slice(0, h.span.start) + h.after + applied.slice(h.span.end);
      expect(applied, `seed ${seed}`).toBe(text);
      expect(bySpan(tidyDeletions(TEXT, tidy)), `seed ${seed}`).toEqual(bySpan(tidy));
      // Deletions alone never leave a line starting with a space: TEXT has none.
      if (edits.every((e) => e.after === '')) for (const line of text.split('\n')) expect(line, `seed ${seed}`).not.toMatch(/^[ \t]/u);
    }
  });
});

// Live run 2 of 17/11, es-email-heavy-4: the edits deleted the lead-in "Mis fortalezas:", the text
// of each numbered item and the paragraph after the list, one sentence at a time (the splitter cuts
// "1. Comunicación clara" into "1." and "Comunicación clara"). The text kept "1.\n2.\n3." on lines
// of their own, between runs of four line breaks.
describe('tidyDeletions over whole lines and lists (es-email-heavy-4, live run 2)', () => {
  const LIST = 'Hola Hernán:\n\nTe escribo por el sitio.\n\nMis fortalezas:\n\n1. Comunicación clara\n2. Atención al detalle\n3. Pasión por aprender\n\nEstoy segura de que podemos.\n\nSaludos,\nValeria';
  const KEPT = 'Hola Hernán:\n\nTe escribo por el sitio.\n\nSaludos,\nValeria';
  const ITEMS = ['Comunicación clara', 'Atención al detalle', 'Pasión por aprender'];
  const MARKERS = ['1.', '2.', '3.'];
  const tidyOf = (text: string, quotes: readonly string[]): AppliedEdit[] => {
    const units = splitSentences(text, 'es');
    const edits = quotes.map((q) => {
      // The sentence that is the quote, or failing that the one that holds it ("1) Comunicación clara").
      const exact = units.findIndex((s) => s.text === q);
      const id = exact >= 0 ? exact : units.findIndex((s) => s.text.includes(q));
      if (id < 0) throw new Error(`no sentence holds ${q}`);
      return edit(id, q, '');
    });
    const placed = applyEdits(text, units, edits);
    expect(placed.rejected).toEqual([]);
    return tidyDeletions(text, placed.accepted);
  };
  const tidyText = (text: string, quotes: readonly string[]): string => renderEdits(text, tidyOf(text, quotes));

  it('leaves no orphan marker and no run of blank lines when the lead-in, every item and the paragraph after are deleted', () => {
    const out = tidyText(LIST, ['Mis fortalezas:', ...MARKERS, ...ITEMS, 'Estoy segura de que podemos.']);
    expect(out).toBe(KEPT);
  });

  it('takes the marker with the item when only the text after it is deleted', () => {
    expect(tidyText(LIST, ['Mis fortalezas:', ...ITEMS, 'Estoy segura de que podemos.'])).toBe(KEPT);
    expect(tidyText(LIST.replace(/(\d)\./gu, '$1)'), ['Mis fortalezas:', ...ITEMS, 'Estoy segura de que podemos.'])).toBe(KEPT);
  });

  it('removes the line of one deleted item, and leaves the other items as they were', () => {
    expect(tidyText(LIST, ['2.', 'Atención al detalle'])).toBe(LIST.replace('2. Atención al detalle\n', ''));
    expect(tidyText(LIST, ['Atención al detalle'])).toBe(LIST.replace('2. Atención al detalle\n', ''));
  });

  it('removes a deleted paragraph with one of the blank lines around it', () => {
    expect(tidyText(LIST, ['Estoy segura de que podemos.'])).toBe(LIST.replace('Estoy segura de que podemos.\n\n', ''));
  });

  it('never touches the blank lines the user wrote', () => {
    const own = 'Hola Hernán:\n\n\n\nTe escribo por el sitio.\n\n\nEstoy segura de que podemos.\n\nSaludos,\nValeria';
    expect(tidyText(own, ['Te escribo por el sitio.'])).toBe(own.replace('Te escribo por el sitio.\n\n\n', ''));
    // Three line breaks of the user's own stay three when the paragraph after them goes.
    expect(tidyText(own, ['Estoy segura de que podemos.'])).toBe(own.replace('Estoy segura de que podemos.\n\n', ''));
    // Nothing deleted: nothing collapsed.
    expect(tidyText(own, [])).toBe(own);
  });

  it('leaves no space at either end of a line, and tidying twice changes nothing', () => {
    const quotes = ['Mis fortalezas:', ...ITEMS, 'Estoy segura de que podemos.'];
    const tidy = tidyOf(LIST, quotes);
    expect(renderEdits(LIST, tidy)).not.toMatch(/(?:^|\n)[ \t]|[ \t](?:\n|$)/u);
    expect(bySpan(tidyDeletions(LIST, tidy))).toEqual(bySpan(tidy));
    for (const a of tidy) expect(LIST.slice(a.span.start, a.span.end)).toBe(a.before);
  });
});
