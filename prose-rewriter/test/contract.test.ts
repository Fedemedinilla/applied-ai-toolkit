// The skeleton contract of phase F0: the shapes rewrite() will take and return.
import { describe, expect, it } from 'vitest';
import { defaultMode, Edit, GENRES, RewriteInput, RewriteResult, STAGES } from '../src/index.ts';

const input = {
  text: 'Te escribo por la propuesta del 3/11.',
  genre: 'follow-up',
  lang: 'es',
  variety: 'rioplatense',
  profile: { cvMarkdown: '# Valeria Sosa Pereyra\n\nAstro, WordPress.' },
};

describe('RewriteInput', () => {
  it('accepts the minimum the design asks for', () => {
    expect(RewriteInput.parse(input)).toEqual(input);
  });

  it('refuses a missing CV, an unknown genre, an unknown key and a variety outside Spanish', () => {
    const { profile: _profile, ...noCv } = input;
    expect(RewriteInput.safeParse(noCv).success).toBe(false);
    expect(RewriteInput.safeParse({ ...input, genre: 'linkedin' }).success).toBe(false);
    expect(RewriteInput.safeParse({ ...input, tone: 'warm' }).success).toBe(false);
    const english = RewriteInput.safeParse({ ...input, lang: 'en' });
    expect(english.success ? [] : english.error.issues.map((i) => i.path.join('.'))).toEqual(['variety']);
  });
});

describe('Edit', () => {
  const edit = { sentenceId: 0, before: 'Te escribo por', after: 'Sigo con', reason: 'arranque directo' };

  it('accepts a labelled placeholder and refuses a bare one', () => {
    expect(Edit.safeParse({ ...edit, after: 'el [COMPLETAR: fecha de entrega]' }).success).toBe(true);
    for (const bare of ['[COMPLETAR]', '[COMPLETAR:]', '[ completar ]']) {
      expect(Edit.safeParse({ ...edit, after: `el ${bare}` }).success).toBe(false);
    }
  });

  it('refuses an empty quote, since code matches `before` exactly', () => {
    expect(Edit.safeParse({ ...edit, before: '' }).success).toBe(false);
  });
});

describe('RewriteResult', () => {
  const result = {
    rewritten: 'Sigo con la propuesta del 3/11.',
    diff: [{ span: { start: 0, end: 14 }, before: 'Te escribo por', after: 'Sigo con' }],
    changes: [
      { id: 'c1', span: { start: 0, end: 14 }, before: 'Te escribo por', after: 'Sigo con', reason: 'arranque directo', stage: 'edit', status: 'applied' },
    ],
    facts: { kept: ['3/11'], dropped: [], added: [], fromCv: [], notInCv: [], placeholders: [] },
    lint: { before: null, after: null },
    flags: [],
    status: 'ok',
    usage: { calls: 2, costUsd: null },
  };

  it('accepts a result whose cost is unknown, and refuses a stage outside the pipeline', () => {
    expect(RewriteResult.safeParse(result).success).toBe(true);
    const change = { ...result.changes[0], stage: 'polish' };
    expect(RewriteResult.safeParse({ ...result, changes: [change] }).success).toBe(false);
  });
});

describe('defaults and lists', () => {
  it('uses the smallest edit on WhatsApp and a polish elsewhere', () => {
    expect(GENRES.map((g) => `${g}:${defaultMode(g)}`)).toEqual(['cover-letter:pulido', 'email:pulido', 'follow-up:pulido', 'whatsapp:minimo']);
  });

  it('names the stages S0 to S7 of the design in order', () => {
    expect(STAGES).toEqual(['prepare', 'analyse', 'plan', 'edit', 'style', 'factcheck', 'relint', 'assemble']);
  });
});
