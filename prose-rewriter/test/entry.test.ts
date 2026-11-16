// The public entry publishes the F4 core: every pure function of voice, facts, edits and injection
// is reachable from src/index.ts, and rewrite() is not there yet (it comes in F5).
import { describe, expect, it } from 'vitest';
import * as entry from '../src/index.ts';

describe('the public entry', () => {
  it.each([
    'voiceProfile', 'voiceViolations', 'voicePromptLines',
    'extract', 'inventory', 'checkEdit', 'factInvariant', 'factReport', 'placeholders',
    'splitSentences', 'textParts', 'applyEdits', 'renderEdits', 'revertEdit', 'diffHunks',
    'injectionFlags', 'wrapData', 'unwrapData', 'restoreData',
  ])('exports %s', (name) => {
    expect(typeof (entry as Record<string, unknown>)[name]).toBe('function');
  });

  it('exports the data tags and not rewrite() yet', () => {
    expect(entry.DATA_TAGS).toEqual(['texto', 'perfil']);
    expect('rewrite' in entry).toBe(false);
  });
});
