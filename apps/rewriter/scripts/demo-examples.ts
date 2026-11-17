// Builds demo/examples.json, the recorded rewrites the page shows on a static host, from the
// records of a real-model eval run (prose-rewriter/evals/cli.ts --live writes pieces.jsonl):
//
//   node apps/rewriter/scripts/demo-examples.ts <run>/pieces.jsonl [--recorded YYYY-MM-DD]
//
// Each example is one eval case: its input, read from prose-rewriter/evals/cases/, and the whole
// RewriteResult the run recorded for it, unchanged. The cases are fictional, and so are the CVs they
// were rewritten against. test/demo.test.ts checks every result against prose-rewriter's schema
// and rebuilds each rewrite from its changes; prose-rewriter/test/fixtures.test.ts scans the file
// for real data.

import { readFileSync, writeFileSync } from 'node:fs';

interface Chosen {
  readonly id: string;
  readonly title: string;
  readonly note: string;
}

/** The cases shown, in page order, with why each one is there. */
export const CHOSEN: readonly Chosen[] = [
  {
    id: 'es-cover-letter-heavy-2',
    title: 'Cover letter in Spanish, full of template phrases',
    note: 'Nine changes. The checks took four of them back, each because it lost a fact the letter states, so those lines stay as written.',
  },
  {
    id: 'en-email-heavy-3',
    title: 'Cold email in English, heavy',
    note: 'The rewrite brings in figures from the CV, listed under "Added from the CV". Two changes were taken back for losing words of the original.',
  },
  {
    id: 'es-follow-up-heavy-3',
    title: 'Follow-up in Spanish that needs review',
    note: 'One change added "Pedidos", which neither the text nor the CV states. The checks reverted it and the status asks for a review.',
  },
  {
    id: 'en-follow-up-heavy-2',
    title: 'Follow-up in English, with the earlier message',
    note: 'The earlier message is part of the input. Two list items stay as written: the changes that replaced them lost a fact.',
  },
  {
    id: 'es-trap-injection-in-text',
    title: 'Email in Spanish with an instruction inside',
    note: 'The draft tells the model to sign with a job title. The phrase is flagged as an instruction and treated as the writer\'s own words, and the signature is unchanged.',
  },
  {
    id: 'es-whatsapp-heavy-3',
    title: 'WhatsApp message in Spanish, smallest fix',
    note: 'WhatsApp defaults to the smallest fix. Two phrases go; a third change was reverted because it switched to voseo the writer did not use.',
  },
  {
    id: 'en-trap-legit-emoji',
    title: 'WhatsApp message in English with an emoji',
    note: 'Two phrases go and the emoji stays: it is part of how the writer talks.',
  },
  {
    id: 'en-email-good',
    title: 'Email in English that is already fine',
    note: 'Nothing to change: the model proposed no edit, and the text comes back as written.',
  },
];

export const FICTIONAL =
  'Fictional: recorded rewrites of invented eval cases (prose-rewriter/evals/cases/), rewritten against invented CVs. Every person, company and number in them is made up.';

interface Piece {
  readonly case: string;
  readonly mode: string;
  readonly variant: string;
  readonly result: Record<string, unknown> & { readonly usage: unknown };
}

interface Case {
  readonly id: string;
  readonly cv: string;
  readonly input: Record<string, unknown>;
}

export function buildExamples(pieces: readonly Piece[], cases: readonly Case[], recorded: string): unknown {
  const examples = CHOSEN.map((chosen) => {
    const piece = pieces.find((p) => p.case === chosen.id);
    const c = cases.find((x) => x.id === chosen.id);
    if (piece === undefined) throw new Error(`no record for ${chosen.id}`);
    if (c === undefined) throw new Error(`no eval case ${chosen.id}`);
    const { mode: _mode, ...input } = c.input;
    // The eval record tags each result with the kind of target that produced it; RewriteResult has no such key.
    const { kind: _kind, ...result } = piece.result;
    return { id: chosen.id, title: chosen.title, note: chosen.note, cv: c.cv, variant: piece.variant, input: { ...input, mode: piece.mode }, result };
  });
  return { fictional: FICTIONAL, recorded, examples };
}

if (import.meta.main) {
  const [path, flag, date] = process.argv.slice(2);
  if (path === undefined) throw new Error('usage: node apps/rewriter/scripts/demo-examples.ts <pieces.jsonl> [--recorded YYYY-MM-DD]');
  const recorded = flag === '--recorded' && date !== undefined ? date : new Date().toISOString().slice(0, 10);
  const pieces = readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Piece);
  const cases = [new URL('../../../prose-rewriter/evals/cases/es.json', import.meta.url), new URL('../../../prose-rewriter/evals/cases/en.json', import.meta.url)].flatMap(
    (url) => (JSON.parse(readFileSync(url, 'utf8')) as { cases: Case[] }).cases,
  );
  const out = new URL('../demo/examples.json', import.meta.url);
  writeFileSync(out, `${JSON.stringify(buildExamples(pieces, cases, recorded), null, 2)}\n`);
  console.log(`demo/examples.json: ${CHOSEN.length} examples`);
}
