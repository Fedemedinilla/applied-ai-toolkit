// The public entry publishes the F4 core: every pure function of voice, facts, edits and injection
// is reachable from src/index.ts, with F5's task configs and gateway ModelClient, and rewrite() is
// not there yet (it comes later in F5).
import { describe, expect, it } from 'vitest';
import * as entry from '../src/index.ts';

describe('the public entry', () => {
  it.each([
    'voiceProfile', 'voiceViolations', 'voicePromptLines',
    'extract', 'inventory', 'checkEdit', 'factInvariant', 'factReport', 'placeholders',
    'splitSentences', 'textParts', 'applyEdits', 'renderEdits', 'revertEdit', 'diffHunks',
    'injectionFlags', 'wrapData', 'unwrapData', 'restoreData',
    'taskConfig', 'callSettings', 'gatewayModelClient',
  ])('exports %s', (name) => {
    expect(typeof (entry as Record<string, unknown>)[name]).toBe('function');
  });

  it('exports the four gateway tasks and their provisional caps', () => {
    expect(entry.REWRITE_TASKS).toEqual(['rewrite.plan', 'rewrite.edit', 'rewrite.style', 'rewrite.judge']);
    expect(Object.keys(entry.TASK_CONFIGS)).toEqual([...entry.REWRITE_TASKS]);
    expect(entry.PROVISIONAL_CAPS).toHaveProperty('monthlyUsd');
  });

  it('exports the data tags and not rewrite() yet', () => {
    expect(entry.DATA_TAGS).toEqual(['texto', 'perfil']);
    expect('rewrite' in entry).toBe(false);
  });
});
