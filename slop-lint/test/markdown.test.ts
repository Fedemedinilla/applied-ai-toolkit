import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { lint } from '../src/lint.ts';
import { blockSentences, maskMarkdown } from '../src/markdown.ts';
import type { LintOptions } from '../src/types.ts';

const md = (text: string, options: Partial<LintOptions> = {}) => lint(text, { lang: 'en', format: 'markdown', ...options });
const ids = (text: string) => md(text).findings.map((f) => f.ruleId);
const fixture = (name: string) => readFileSync(new URL(`../fixtures/cover-letters/${name}`, import.meta.url), 'utf8');

/** 36 words without a period, a comma or a Tier 2 word: long enough for EST-10. */
const LONG =
  'I built the weekly report that the managers of all thirty branches read on Monday and I wrote the queries that feed it ' +
  'and the checks that match stock against invoicing for each branch every week';

describe('maskMarkdown', () => {
  it('keeps the length and every newline, so offsets, lines and columns do not move', () => {
    const source = '# Title\n\nSome `code` and a [link](https://example.com).\n\n```ts\nconst x = 1;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n';
    const { text } = maskMarkdown(source);
    expect(text).toHaveLength(source.length);
    expect([...text].flatMap((c, i) => (c === '\n' ? [i] : []))).toEqual([...source].flatMap((c, i) => (c === '\n' ? [i] : [])));
  });

  it('removes code, tables, comments, link URLs, emphasis and block markers, and keeps the link text', () => {
    const source = [
      '## Heading ##',
      '',
      '- **Bold** item with `inline code` and a [link text](https://example.com/x "title").',
      '1. Numbered <!-- a comment --> item.',
      '> Quoted line.',
      '',
      '```',
      'fenced code',
      '```',
      '',
      '| col | col |',
      '| --- | --- |',
      '| cell | cell |',
      '',
      '![alt text](image.png) and <br> and \\*not emphasis\\*.',
    ].join('\n');
    const lines = maskMarkdown(source).text.split('\n').map((l) => l.replace(/ +/gu, ' ').trim());
    expect(lines).toEqual([
      'Heading',
      '',
      'Bold item with and a link text .',
      'Numbered item.',
      'Quoted line.',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      'and and *not emphasis *.',
    ]);
  });

  it('runs an unclosed fence to the end of the file and reads a longer fence as code', () => {
    expect(maskMarkdown('Text.\n````\n```\nstill code\n````\nProse.').text.trim().split(/\s+/u)).toEqual(['Text.', 'Prose.']);
    expect(maskMarkdown('Text.\n```\nnever closed').text.trim()).toBe('Text.');
  });

  it('gives each list item, heading and paragraph its own block', () => {
    // "more of two" is a second paragraph of the second item: a block of its own, still in the list.
    const view = maskMarkdown('# Title\nIntro line.\n\n- one\n- two\n  continued\n\n  more of two\n\nA paragraph.');
    expect(view.blocks.map((b) => b.kind)).toEqual(['heading', 'paragraph', 'list', 'list', 'list', 'paragraph']);
  });

  it('does not let a sentence run from one list item into the next', () => {
    const view = maskMarkdown('- the first item\n- the second item\n- the third item');
    expect(blockSentences(view).map((s) => s.text)).toEqual(['the first item', 'the second item', 'the third item']);
  });

  it('ends a sentence before inline code that opens the next one', () => {
    const view = maskMarkdown('It runs offline. `lint` is a pure function.');
    expect(blockSentences(view).map((s) => s.text.trim())).toEqual(['It runs offline.', 'is a pure function.']);
  });
});

describe('lint in Markdown mode', () => {
  it('points every finding into the original file', () => {
    const source = '# A title\n\n```\nleverage\n```\n\n- Ultimately, I am passionate about **data**.\n';
    const result = md(source);
    expect(result.findings.map((f) => f.ruleId)).toEqual(['EST-05', 'LEX-03']);
    for (const f of result.findings) expect(source.slice(f.start, f.end)).toBe(f.match);
    expect(result.findings.map((f) => [f.line, f.column])).toEqual([
      [7, 3],
      [7, 20],
    ]);
  });

  it('quotes the original text in a match that spans masked code', () => {
    const source = `Intro.\n\n${LONG.replace('queries', 'queries in `sql/`')}.`;
    const finding = md(source).findings.find((f) => f.ruleId === 'EST-10');
    expect(finding?.match).toContain('`sql/`');
    expect(source.slice(finding?.start, finding?.end)).toBe(finding?.match);
  });

  it('ignores fenced code blocks and inline code', () => {
    expect(ids('Intro.\n\n```text\nI am passionate about data. Ultimately, it is a testament.\n```\n')).toEqual([]);
    expect(ids('Intro.\n\n~~~\nleverage\n~~~\n')).toEqual([]);
    expect(ids('The rule lists `passionate about` and `testament to`.')).toEqual([]);
  });

  it('ignores tables', () => {
    expect(ids('| phrase | rule |\n|---|---|\n| passionate about | LEX-03 |\n| [Company Name] | FMT-04 |\n')).toEqual([]);
  });

  it('reads link text and drops the URL', () => {
    expect(ids('See [the design notes](#design-decisions) for the full list.')).toEqual([]);
    expect(ids('See [the design notes](https://example.com/leverage).')).toEqual([]);
    expect(ids('I am [passionate about](https://example.com) data.')).toEqual(['LEX-03']);
  });

  it('skips FMT-01, which only makes sense in plain text, and keeps the other rules', () => {
    const source = '# Title\n\n- **Bold** item.\n- I am passionate about data.\n';
    expect(lint(source, { lang: 'en' }).findings.map((f) => f.ruleId)).toContain('FMT-01');
    expect(ids(source)).toEqual(['LEX-03']);
  });

  it('still reports an emoji and a real placeholder', () => {
    expect(ids('Shipped it 🚀.')).toEqual(['FMT-02']);
    expect(ids('I am excited to join [Company Name].')).toEqual(['FMT-04']);
  });

  it('counts inline code as an anchor', () => {
    expect(ids('I like the team.')).toEqual([]);
    expect(md('The team runs `lint` daily.').stats.anchors).toBe(1);
  });
});

describe('EST-10 in Markdown mode', () => {
  it('flags a long sentence in a paragraph, as in plain text', () => {
    expect(ids(`${LONG}.`)).toEqual(['EST-10']);
    expect(lint(`${LONG}.`, { lang: 'en' }).findings.map((f) => f.ruleId)).toEqual(['EST-10']);
  });

  it('does not join lowercase list items into one long sentence', () => {
    // Once the markers are masked, each line starts in lowercase, which plain-text
    // splitting reads as a hard-wrapped paragraph: eight items become one 56-word sentence.
    const list = Array.from({ length: 8 }, (_, i) => `- the check number ${i + 1} in the list`).join('\n');
    expect(lint(maskMarkdown(list).text, { lang: 'en' }).findings.map((f) => f.ruleId)).toEqual(['EST-10']);
    expect(ids(list)).toEqual([]);
  });

  it('leaves a one-sentence list item out and measures a list item written as a paragraph', () => {
    expect(ids(`- \`file.ts\`: ${LONG}.`)).toEqual([]);
    expect(ids(`- It is short. ${LONG}.`)).toEqual(['EST-10']);
  });

  it('leaves headings and quotes out', () => {
    expect(ids(`# ${LONG}`)).toEqual([]);
    expect(ids(`> ${LONG}.`)).toEqual([]);
  });
});

describe('disable directives', () => {
  it('skips everything between disable and enable', () => {
    const source = 'The banned phrases include <!-- slop-lint-disable -->passionate about<!-- slop-lint-enable --> and others.';
    expect(ids(source)).toEqual([]);
    expect(ids(source.replace(/<!--[^>]*-->/gu, ''))).toEqual(['LEX-03']);
  });

  it('works across lines and blocks, and runs to the end without an enable', () => {
    expect(ids('Intro.\n\n<!-- slop-lint-disable -->\n\nI am passionate about data.\n\n<!-- slop-lint-enable -->\n\nDone.')).toEqual([]);
    expect(ids('Intro.\n<!-- slop-lint-enable -->\nI am passionate about data.')).toEqual(['LEX-03']);
    expect(ids('Intro.\n<!-- slop-lint-disable -->\nI am passionate about data.\n\nI am passionate about it.')).toEqual([]);
  });

  it('skips only the next line with disable-next-line', () => {
    const source = '<!-- slop-lint-disable-next-line -->\nI am passionate about data.\nI am passionate about people.\n';
    const result = md(source);
    expect(result.findings.map((f) => [f.ruleId, f.line])).toEqual([['LEX-03', 3]]);
  });

  it('is not a directive inside a code block', () => {
    expect(ids('```\n<!-- slop-lint-disable -->\n```\nI am passionate about data.')).toEqual(['LEX-03']);
  });

  it('is only read in Markdown mode', () => {
    const source = '<!-- slop-lint-disable-next-line -->\nI am passionate about data.';
    expect(lint(source, { lang: 'en' }).findings.map((f) => f.ruleId)).toEqual(['LEX-03']);
  });
});

describe('text mode', () => {
  it('is the default, and format "text" gives the same result', () => {
    for (const name of ['en-before.txt', 'es-rioplatense-before.txt', 'es-neutral-after.txt']) {
      const text = fixture(name);
      const lang = name.startsWith('en') ? 'en' : 'es';
      expect(lint(text, { lang, format: 'text' })).toEqual(lint(text, { lang }));
    }
  });

  it('still reads Markdown syntax as typed', () => {
    const source = '## Title\n\n- **Bold** item with `passionate about` inside code.\n\n```\nleverage\n```\n';
    const found = lint(source, { lang: 'en' }).findings.map((f) => f.ruleId);
    expect(found).toContain('FMT-01');
    expect(found).toContain('LEX-03');
  });
});
