// F5b: the CLI's testable core (src/cli.ts), over the scripted gateway. No test builds a live
// gateway: the gateway factory is injected, and the key is a fixture string the factory ignores.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EXIT, loadRefs, parseArgs, runCli, USAGE, type CliDeps } from '../src/cli.ts';
import { RewriteResult } from '../src/types.ts';
import { SetupError, type Gateway } from '../../gateway/src/index.ts';
import { scriptedGateway, type Script, type ScriptedGateway } from './scripted-gateway.ts';

const CV_ES = readFileSync(new URL('../evals/cases/cv/es-rioplatense.md', import.meta.url), 'utf8');
const REFS = loadRefs(new URL('../../', import.meta.url));

const CHAT = 'Hola Marta, espero que estés bien. Quería comentarte que me apasiona potenciar sinergias. El sitio de la panadería ya carga en 1,6 s. ¿Lo vemos el jueves?';
const CLEAN = 'Hola Marta, te paso el link del sitio nuevo de la panadería. Lo armé en Astro y carga en 1,6 s. Avisame si querés que lo veamos el jueves.';
const SINERGIAS = 'Quería comentarte que me apasiona potenciar sinergias.';
const FIXED = 'Quería contarte que el sitio está listo.';
/** A path that must never reach the output. */
const CV_PATH = '/home/fiction/secret-folder/cv-valeria.md';

const plan = (...ids: number[]) => ({ data: { items: ids.map((sentenceId) => ({ sentenceId, action: 'remove-formula', reason: 'set phrase', ruleId: 'LEX-01' })) } });
const edits = (...list: Array<{ sentenceId: number; before: string; after: string }>) => ({ data: { edits: list.map((e) => ({ reason: 'fix the set phrase', ...e })) } });

interface Run {
  readonly code: number;
  readonly out: string;
  readonly err: string;
  readonly keys: string[];
  readonly calls: ScriptedGateway['calls'];
}

async function run(argv: string[], script: Script = {}, extra: { files?: Record<string, string>; apiKey?: string | undefined; gateway?: Gateway } = {}): Promise<Run> {
  const files: Record<string, string> = { 'draft.txt': CHAT, [CV_PATH]: CV_ES, ...extra.files };
  const scripted = scriptedGateway(script);
  let out = '';
  let err = '';
  const keys: string[] = [];
  const deps: CliDeps = {
    apiKey: 'apiKey' in extra ? extra.apiKey : 'sk-fixture',
    readFile: (path) => {
      const content = files[path];
      if (content === undefined) throw new Error(`ENOENT: no such file, open '${path}'`);
      return content;
    },
    stdout: (s) => (out += s),
    stderr: (s) => (err += s),
    gateway: (apiKey) => {
      keys.push(apiKey);
      return extra.gateway ?? scripted.gateway;
    },
    refs: () => REFS,
  };
  const code = await runCli(argv, deps);
  return { code, out, err, keys, calls: scripted.calls };
}

const BASE = ['--genre', 'whatsapp', '--lang', 'es', '--variety', 'rioplatense', '--cv', CV_PATH];

describe('parseArgs', () => {
  it('reads every flag of design 4.11, with --keep repeatable', () => {
    const args = parseArgs([...BASE, '--to', 'to.json', '--previous', 'prev.txt', '--mode', 'pulido', '--keep', 'el jueves', '--keep=1,6 s', '--strict', '--json', 'draft.txt']);
    expect(args).toEqual({
      genre: 'whatsapp',
      lang: 'es',
      variety: 'rioplatense',
      cv: CV_PATH,
      to: 'to.json',
      previous: 'prev.txt',
      mode: 'pulido',
      keep: ['el jueves', '1,6 s'],
      strict: true,
      json: true,
      draft: 'draft.txt',
    });
  });

  it.each([
    [['--lang', 'es', '--cv', 'cv.md', 'draft.txt'], /--genre/],
    [['--genre', 'whatsapp', '--cv', 'cv.md', 'draft.txt'], /--lang/],
    [['--genre', 'whatsapp', '--lang', 'es', 'draft.txt'], /--cv/],
    [['--genre', 'whatsapp', '--lang', 'es', '--cv', 'cv.md'], /draft/],
    [['--genre', 'whatsapp', '--lang', 'es', '--cv', 'cv.md', 'a.txt', 'b.txt'], /one draft/],
    [['--genre', 'letter', '--lang', 'es', '--cv', 'cv.md', 'draft.txt'], /--genre/],
    [['--genre', 'whatsapp', '--lang', 'pt', '--cv', 'cv.md', 'draft.txt'], /--lang/],
    [['--genre', 'whatsapp', '--lang', 'es', '--variety', 'porteño', '--cv', 'cv.md', 'draft.txt'], /--variety/],
    [['--genre', 'whatsapp', '--lang', 'es', '--mode', 'total', '--cv', 'cv.md', 'draft.txt'], /--mode/],
    [['--genre', 'whatsapp', '--lang', 'es', '--cv', 'cv.md', '--bogus', 'draft.txt'], /--bogus/],
    [['--genre', 'whatsapp', '--lang', 'es', '--cv'], /--cv/],
    [['--genre', 'whatsapp', '--lang', 'es', '--cv=', 'draft.txt'], /--cv needs a value/],
    [['--genre', 'whatsapp', '--lang', 'es', '--cv', 'cv.md', '--keep', '', 'draft.txt'], /--keep needs a value/],
    [['--genre', 'whatsapp', '--lang', 'es', '--cv', 'cv.md', '--json=1', 'draft.txt'], /--json takes no value/],
    [['--genre', 'whatsapp', '--lang', 'es', '--cv', 'cv.md', '--mode', 'minimo', '--mode', 'pulido', 'draft.txt'], /--mode is given twice/],
  ])('refuses %j', (argv, message) => {
    const args = parseArgs(argv);
    expect(typeof args).toBe('string');
    expect(args).toMatch(message);
  });
});

describe('parseArgs: the end of the options', () => {
  it('reads every argument after -- as the draft, even one that starts with --', () => {
    expect(parseArgs(['--genre', 'whatsapp', '--lang', 'es', '--cv', 'cv.md', '--', '--draft.txt'])).toMatchObject({ draft: '--draft.txt' });
  });
});

describe('runCli: usage errors', () => {
  it('exits with the usage code and the usage line on bad arguments, before any call', async () => {
    const r = await run(['--genre', 'whatsapp', 'draft.txt']);
    expect(r.code).toBe(EXIT.usage);
    expect(r.err).toContain(USAGE);
    expect(r.out).toBe('');
    expect(r.keys).toEqual([]);
  });

  it('prints the usage on --help with exit 0', async () => {
    const r = await run(['--help']);
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toContain(USAGE);
  });

  it('prints the usage on -h, but reads -h as a value when it follows an option that takes one', async () => {
    expect((await run(['-h'])).out).toContain(USAGE);
    const r = await run([...BASE, '--keep', '-h', 'clean.txt'], {}, { files: { 'clean.txt': CLEAN } });
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).not.toContain(USAGE);
    expect(r.out).toContain(CLEAN);
  });

  it('refuses a variety with English (the input schema), with the usage code', async () => {
    const r = await run(['--genre', 'email', '--lang', 'en', '--variety', 'neutral', '--cv', CV_PATH, 'draft.txt']);
    expect(r.code).toBe(EXIT.usage);
    expect(r.err).toMatch(/variety/);
  });

  it('never echoes the CV path when the CV cannot be read', async () => {
    const r = await run(['--genre', 'whatsapp', '--lang', 'es', '--cv', '/home/fiction/missing/cv.md', 'draft.txt']);
    expect(r.code).toBe(EXIT.usage);
    expect(r.err).toMatch(/could not read the CV/);
    expect(r.err + r.out).not.toContain('missing');
    expect(r.err + r.out).not.toContain('cv.md');
  });

  it('names an unreadable draft by its path', async () => {
    const r = await run([...BASE, 'nope.txt']);
    expect(r.code).toBe(EXIT.usage);
    expect(r.err).toMatch(/nope\.txt/);
  });

  it('refuses a recipient file that is not the recipient shape', async () => {
    const r = await run([...BASE, '--to', 'to.json', 'draft.txt'], {}, { files: { 'to.json': '{"name":"Marta","email":"x@example.com"}' } });
    expect(r.code).toBe(EXIT.usage);
    expect(r.err).toMatch(/recipient/);
  });
});

describe('runCli: the API key', () => {
  it.each([[undefined], ['   ']])('refuses to run without ANTHROPIC_API_KEY (%j), with its own code and no gateway built', async (apiKey) => {
    const r = await run([...BASE, '--mode', 'pulido', 'draft.txt'], {}, { apiKey });
    expect(r.code).toBe(EXIT.failed);
    expect(r.err).toMatch(/ANTHROPIC_API_KEY/);
    expect(r.keys).toEqual([]);
  });

  it('does not need the key when S1b returns before any model call', async () => {
    const r = await run([...BASE, 'clean.txt'], {}, { files: { 'clean.txt': CLEAN }, apiKey: undefined });
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toContain(CLEAN);
    expect(r.out).toMatch(/No encontré nada para cambiar/);
  });

  it('passes the trimmed key to the gateway factory', async () => {
    const r = await run([...BASE, 'draft.txt'], { 'rewrite.plan': [plan(1)], 'rewrite.edit': [edits({ sentenceId: 1, before: SINERGIAS, after: FIXED })] }, { apiKey: ' sk-fixture ' });
    expect(r.code).toBe(EXIT.ok);
    expect(r.keys).toEqual(['sk-fixture']);
  });
});

describe('runCli: output and exit codes', () => {
  const OK: Script = { 'rewrite.plan': [plan(1)], 'rewrite.edit': [edits({ sentenceId: 1, before: SINERGIAS, after: FIXED })] };

  it('prints the text, the changes with their reasons, the facts and the status; exit 0 on ok', async () => {
    const r = await run([...BASE, 'draft.txt'], OK);
    expect(r.code).toBe(EXIT.ok);
    expect(r.out.startsWith(CHAT.replace(SINERGIAS, FIXED))).toBe(true);
    expect(r.out).toMatch(/Changes/);
    expect(r.out).toContain('applied');
    expect(r.out).toContain('fix the set phrase');
    expect(r.out).toMatch(/Facts/);
    expect(r.out).toMatch(/Status: ok/);
    expect(r.out).not.toContain(CV_PATH);
    expect(r.err).toBe('');
  });

  it('prints the RewriteResult with --json', async () => {
    const r = await run([...BASE, '--json', 'draft.txt'], OK);
    expect(r.code).toBe(EXIT.ok);
    const result = RewriteResult.parse(JSON.parse(r.out));
    expect(result.rewritten).toBe(CHAT.replace(SINERGIAS, FIXED));
    expect(result.usage.calls).toBe(2);
  });

  it('exits 1 on needs-review, with the reverted change and its reason', async () => {
    const r = await run([...BASE, 'draft.txt'], {
      'rewrite.plan': [plan(1, 2)],
      'rewrite.edit': [edits({ sentenceId: 1, before: SINERGIAS, after: FIXED }, { sentenceId: 2, before: 'El sitio de la panadería ya carga en 1,6 s.', after: 'El sitio de la panadería, hecho en React, ya carga en 1,6 s.' })],
    });
    expect(r.code).toBe(EXIT.needsReview);
    expect(r.out).toMatch(/Status: needs-review/);
    expect(r.out).toMatch(/reverted.*\n.*React/);
  });

  it('exits 2 on blocked', async () => {
    const invent = { sentenceId: 1, before: SINERGIAS, after: 'Quería contarte que el sitio está hecho en React.' };
    const r = await run([...BASE, 'draft.txt'], { 'rewrite.plan': [plan(1)], 'rewrite.edit': [edits(invent), edits(invent)] });
    expect(r.code).toBe(EXIT.blocked);
    expect(r.out).toMatch(/Status: blocked/);
  });

  it('passes --keep, --to and --previous into the input', async () => {
    const r = await run(
      [...BASE, '--keep', '¿Lo vemos el jueves?', '--to', 'to.json', '--previous', 'prev.txt', '--json', 'draft.txt'],
      { 'rewrite.plan': [plan(1, 3)], 'rewrite.edit': [edits({ sentenceId: 1, before: SINERGIAS, after: FIXED }, { sentenceId: 3, before: 'el jueves', after: 'el viernes' })] },
      { files: { 'to.json': '{"name":"Marta","org":"Panadería Los Álamos"}', 'prev.txt': 'Hola Valeria, ¿cómo va el sitio?' } },
    );
    const result = RewriteResult.parse(JSON.parse(r.out));
    expect(result.rewritten).toContain('¿Lo vemos el jueves?');
    expect(result.changes.find((c) => c.after === 'el viernes')).toMatchObject({ status: 'reverted' });
    const prompt = JSON.stringify(r.calls[0]?.request);
    expect(prompt).toContain('Panadería Los Álamos');
    expect(prompt).toContain('Hola Valeria, ¿cómo va el sitio?');
  });

  it('flags a claim not in the CV in the text output (D7)', async () => {
    const draft = 'Hola Marta, espero que estés bien. Quería comentarte que me apasiona potenciar sinergias. Hice 30 sitios así en 2024. ¿Lo vemos el jueves?';
    const r = await run([...BASE, 'claim.txt'], OK, { files: { 'claim.txt': draft } });
    expect(r.out).toMatch(/Flags/);
    expect(r.out).toContain('not-in-cv');
  });

  it('reports a failed gateway call with its name, code and message, never the error cause', async () => {
    const failing: Gateway = {
      structured: async () => {
        throw new SetupError('the gateway is not set up', { cause: new Error('cause with secret-detail') });
      },
      structuredStream: () => {
        throw new Error('not used');
      },
      text: async () => {
        throw new Error('not used');
      },
    };
    const r = await run([...BASE, 'draft.txt'], {}, { gateway: failing });
    expect(r.code).toBe(EXIT.failed);
    expect(r.err).toBe('rewrite failed: SetupError (invalid_setup): the gateway is not set up\n');
    expect(r.out).toBe('');
  });

  it('reports any other failure by its name only', async () => {
    const r = await run([...BASE, 'draft.txt'], { 'rewrite.plan': [plan(1)] });
    expect(r.code).toBe(EXIT.failed);
    expect(r.err).toBe('rewrite failed: UnscriptedCallError\n');
  });

  it('gives every call of one run the same fresh jobId, for the per-job cap', async () => {
    const r = await run([...BASE, 'draft.txt'], OK);
    const ids = new Set(r.calls.map((c) => c.request.jobId));
    expect(ids.size).toBe(1);
    expect([...ids][0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  });
});

describe('loadRefs', () => {
  it('loads and validates style-refs\' sources, principles and examples for both languages', () => {
    expect(REFS.sources.length).toBeGreaterThan(0);
    expect(new Set(REFS.principles.map((p) => p.lang))).toEqual(new Set(['es', 'en']));
    expect(new Set(REFS.examples.map((e) => e.lang))).toEqual(new Set(['es', 'en']));
  });
});
