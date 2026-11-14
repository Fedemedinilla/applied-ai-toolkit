// The generated parts of the docs cannot drift from the workflow files: the
// two README tables, the diagrams, and the one-test-file-per-workflow rule.
// To update them after changing a workflow: node n8n-templates/scripts/docs.ts

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT, loadTemplates } from '../harness/workflow.ts';
import { BLOCKS, DIAGRAMS_DIR, README_PATH, block, diagram, readBlock, services, triggers } from '../scripts/docs.ts';

const templates = loadTemplates();
const readme = readFileSync(README_PATH, 'utf8');
const TEST_DIR = join(ROOT, 'test');
/** Test files in test/ that are not about one workflow. */
const SHARED_TESTS = ['docs.test.ts', 'structure.test.ts'];

describe('README tables', () => {
  it.each(BLOCKS)('the generated "%s" table matches the workflow files', (name) => {
    expect(readBlock(readme, name), `run: node n8n-templates/scripts/docs.ts`).toBe(block(name, templates));
  });

  it('has one row per workflow, each with a trigger, a test file and a diagram that exist', () => {
    const table = readBlock(readme, 'workflows') ?? '';
    const rows = table.split('\n').slice(2);
    expect(rows).toHaveLength(templates.length);
    for (const t of templates) {
      const row = rows.find((r) => r.startsWith(`| \`${t.file}\` |`));
      expect(row, t.file).toBeDefined();
      expect(row).toContain(`(test/${t.base}.test.ts)`);
      expect(row).toContain(`(diagrams/${t.base}.md)`);
      expect(triggers(t).length, t.file).toBeGreaterThan(0);
      expect(existsSync(join(TEST_DIR, `${t.base}.test.ts`)), `no test file for ${t.file}`).toBe(true);
    }
  });

  it('names a service for every node that calls out', () => {
    const calling = templates.filter((t) => t.workflow.nodes.some((n) => /httpRequest|gmail|googleSheets|telegram|lmChat/.test(n.type)));
    expect(calling).toHaveLength(templates.length);
    for (const t of calling) expect(services(t).length, t.file).toBeGreaterThan(0);
  });

  it('lists the typeVersion of every node in every file', () => {
    const table = readBlock(readme, 'versions') ?? '';
    for (const t of templates) {
      for (const node of t.workflow.nodes) {
        const row = table.split('\n').find((r) => r.startsWith(`| \`${node.type}\` |`));
        expect(row, node.type).toBeDefined();
        const versions = (row?.split('|')[2] ?? '').split(',').map((v) => Number(v.trim()));
        expect(versions, `${t.file} / ${node.name}`).toContain(node.typeVersion);
      }
    }
  });

  it('has a "What these templates do not do" section and states the replay limit the tests pin', () => {
    expect(readme).toMatch(/^## What these templates do not do$/m);
    expect(readme).toContain('MercadoPago signatures are not checked for age');
  });
});

describe('test files', () => {
  it('has exactly one test file per workflow, plus the shared ones', () => {
    const found = readdirSync(TEST_DIR).filter((f) => f.endsWith('.test.ts')).sort();
    const wanted = [...templates.map((t) => `${t.base}.test.ts`), ...SHARED_TESTS].sort();
    expect(found).toEqual(wanted);
  });

  it('each workflow test loads its own workflow file', () => {
    for (const t of templates) {
      const source = readFileSync(join(TEST_DIR, `${t.base}.test.ts`), 'utf8');
      expect(source, t.base).toContain(`loadTemplate('${t.file}')`);
    }
  });
});

describe('diagrams', () => {
  it('has one up-to-date diagram per workflow and nothing else', () => {
    expect(readdirSync(DIAGRAMS_DIR).sort()).toEqual(templates.map((t) => `${t.base}.md`).sort());
    for (const t of templates) {
      const onDisk = readFileSync(join(DIAGRAMS_DIR, `${t.base}.md`), 'utf8');
      expect(onDisk, `run: node n8n-templates/scripts/docs.ts`).toBe(diagram(t));
    }
  });

  it('draws every working node once and every connection once', () => {
    for (const t of templates) {
      const text = diagram(t);
      const working = t.workflow.nodes.filter((n) => n.type !== 'n8n-nodes-base.stickyNote');
      const edges = Object.values(t.workflow.connections).flatMap((byType) => Object.values(byType).flat(2));
      expect(text.match(/^ {2}n\d+[([{]/gm), t.file).toHaveLength(working.length);
      expect(text.match(/^ {2}n\d+ (-->|-- |-\. )/gm), t.file).toHaveLength(edges.length);
      for (const node of working) expect(text, `${t.file} / ${node.name}`).toContain(`"${node.name.replace(/"/g, '#quot;')}"`);
    }
  });

  it('labels the outputs of If nodes, so the discard branch is visible', () => {
    const invoicing = templates.find((t) => t.base === 'mercadopago-payment-to-afip-invoice');
    if (!invoicing) throw new Error('the invoicing workflow is missing');
    const text = diagram(invoicing);
    expect(text).toMatch(/-- true --> n\d+/);
    expect(text).toMatch(/-- false --> n\d+/);
  });
});
