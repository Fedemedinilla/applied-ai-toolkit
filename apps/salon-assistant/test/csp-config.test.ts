// The build is checked against the literal in csp-guard.config.json, and the server sends CSP.
// This test keeps the two equal, so the guard cannot pass while the header drifts.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { CSP } from '../server/csp.ts';

describe('csp-guard.config.json', () => {
  it('checks the build against the same policy the server sends', () => {
    const config: unknown = JSON.parse(readFileSync(new URL('../csp-guard.config.json', import.meta.url), 'utf8'));
    expect(config).toMatchObject({ csp: { from: 'literal', value: CSP } });
  });

  it('is the policy the static server sends', () => {
    const serve = readFileSync(new URL('../server/static.ts', import.meta.url), 'utf8');
    expect(serve).toMatch(/import \{ CSP \} from '\.\/csp\.ts';/);
    expect(serve).toMatch(/'content-security-policy': CSP/i);
  });
});
