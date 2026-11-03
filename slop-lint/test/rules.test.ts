import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { lint, rawMatches } from '../src/lint.ts';
import { PATTERN_RULES, RULES, STRUCTURAL_RULES, TUTEO, VOSEO } from '../src/rules.ts';
import { STRUCTURAL_CHECK_IDS } from '../src/structural.ts';
import type { Lang } from '../src/types.ts';

const langsOf = (lang: 'en' | 'es' | 'both'): Lang[] => (lang === 'both' ? ['en', 'es'] : [lang]);

describe('catalog', () => {
  it('has unique ids', () => {
    const ids = RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('compiles every pattern with giu and with its declared flags', () => {
    for (const rule of PATTERN_RULES) {
      for (const source of [...Object.values(rule.patterns), ...Object.values(rule.closingPatterns ?? {})]) {
        expect(() => new RegExp(source, 'giu'), rule.id).not.toThrow();
        expect(() => new RegExp(source, rule.flags), rule.id).not.toThrow();
      }
      expect(rule.flags, rule.id).toContain('g');
      expect(rule.flags, rule.id).toContain('u');
    }
    expect(() => new RegExp(VOSEO, 'giu')).not.toThrow();
    expect(() => new RegExp(TUTEO, 'giu')).not.toThrow();
  });

  it('compiles the case-sensitive format rules without i', () => {
    // Under iu, \p{Lu} also matches lowercase letters and [A-Z] matches "div".
    for (const id of ['FMT-03', 'FMT-04']) {
      const rule = PATTERN_RULES.find((r) => r.id === id);
      expect(rule?.flags, id).toBeDefined();
      expect(rule?.flags, id).not.toContain('i');
    }
  });

  it('gives each pattern rule a source for every language it claims', () => {
    for (const rule of PATTERN_RULES) {
      expect(Object.keys(rule.patterns).sort(), rule.id).toEqual(langsOf(rule.lang));
    }
  });

  it('derives levels from the report: level 1 only for high or disqualifying rules', () => {
    for (const rule of RULES.filter((r) => r.level === 1)) {
      expect(['high', 'disqualify'], rule.id).toContain(rule.severity);
    }
  });

  it('tags every rule with evidence and a report section, and gives it examples', () => {
    for (const rule of RULES) {
      expect(rule.source.evidence.length, rule.id).toBeGreaterThan(0);
      expect(rule.source.section, rule.id).not.toBe('');
      expect(rule.examples.length, rule.id).toBeGreaterThan(0);
      for (const ex of rule.examples) expect(langsOf(rule.lang), rule.id).toContain(ex.lang);
    }
  });

  it('is listed in the README, rule by rule', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    for (const rule of RULES) expect(readme, rule.id).toContain(`| ${rule.id} |`);
  });

  it('has exactly one structural check per structural rule', () => {
    expect([...STRUCTURAL_CHECK_IDS].sort()).toEqual(STRUCTURAL_RULES.map((r) => r.id).sort());
  });
});

describe('pattern rules fire on their example and not on the near-miss', () => {
  for (const rule of PATTERN_RULES) {
    for (const ex of rule.examples) {
      it(`${rule.id} (${ex.lang}): ${ex.fire}`, () => {
        expect(rawMatches(rule, ex.fire, ex.lang).length).toBeGreaterThan(0);
        expect(rawMatches(rule, ex.pass, ex.lang)).toEqual([]);
      });
    }
  }
});

describe('structural rules fire on their example and not on the near-miss', () => {
  for (const rule of STRUCTURAL_RULES) {
    for (const ex of rule.examples) {
      it(`${rule.id} (${ex.lang})`, () => {
        const ids = (text: string) => lint(text, { lang: ex.lang }).findings.map((f) => f.ruleId);
        expect(ids(ex.fire)).toContain(rule.id);
        expect(ids(ex.pass)).not.toContain(rule.id);
      });
    }
  }
});
