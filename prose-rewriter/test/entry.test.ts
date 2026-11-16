// The public entry publishes the F4 core: every pure function of voice, facts, edits and injection
// is reachable from src/index.ts, with F5a's task configs, gateway ModelClient, prompt and output
// schemas, and rewrite() is not there yet (it comes in F5b).
import { describe, expect, it } from 'vitest';
import * as entry from '../src/index.ts';

describe('the public entry', () => {
  it.each([
    'voiceProfile', 'voiceViolations', 'voicePromptLines',
    'extract', 'inventory', 'checkEdit', 'factInvariant', 'factReport', 'placeholders',
    'splitSentences', 'textParts', 'applyEdits', 'renderEdits', 'revertEdit', 'diffHunks',
    'injectionFlags', 'wrapData', 'unwrapData', 'restoreData',
    'taskConfig', 'callSettings', 'gatewayModelClient',
    'systemBlocks', 'planPrompt', 'editPrompt', 'stylePrompt', 'styleOutput',
  ])('exports %s', (name) => {
    expect(typeof (entry as Record<string, unknown>)[name]).toBe('function');
  });

  it('exports the four gateway tasks and their provisional caps', () => {
    expect(entry.REWRITE_TASKS).toEqual(['rewrite.plan', 'rewrite.edit', 'rewrite.style', 'rewrite.judge']);
    expect(Object.keys(entry.TASK_CONFIGS)).toEqual([...entry.REWRITE_TASKS]);
    expect(entry.PROVISIONAL_CAPS).toHaveProperty('monthlyUsd');
  });

  it('exports the prompt rules and the output schemas of S2 to S4', () => {
    expect(entry.HARD_RULES).toHaveLength(3);
    expect(entry.PLAN_ACTIONS).toEqual(['cut', 'make-specific', 'remove-formula', 'keep']);
    expect(entry.PlanOutput.safeParse({ items: [] }).success).toBe(true);
    expect(entry.EditOutput.safeParse({ edits: [] }).success).toBe(true);
    expect(entry.STYLE_MAX_EDITS).toBeGreaterThan(0);
    expect(entry.EDIT_EXTRA_SENTENCES).toBeGreaterThan(0);
  });

  it('exports the data tags and not rewrite() yet', () => {
    expect(entry.DATA_TAGS).toEqual(['texto', 'perfil']);
    expect('rewrite' in entry).toBe(false);
  });
});
