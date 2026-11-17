// prose-rewriter's reasons for taking a change back are written for the toolkit
// (prose-rewriter/src/facts.ts, stages/check.ts, rewrite.ts). The page shows them in plain English;
// a reason it does not know passes through as it is.

const RULES: ReadonlyArray<readonly [RegExp, (m: RegExpMatchArray) => string]> = [
  [/^facts: loses (.+) without drop$/su, (m) => `It would have removed something your text states: ${m[1] ?? ''}.`],
  [/^facts: adds (.+), found in neither the text nor the CV$/su, (m) => `It would have added ${m[1] ?? ''}, which neither your text nor your CV states.`],
  [/^voice: (.+)$/su, (m) => `It changed your voice: ${m[1] ?? ''}`],
  [/^relint: adds the level 1 finding (.+)$/su, (m) => `It would have added a level 1 pattern (${m[1] ?? ''}).`],
  [/^schema: /u, () => "The model's edit was malformed, so it was not placed."],
];

export function explainRevert(reason: string): string {
  for (const [pattern, say] of RULES) {
    const m = reason.match(pattern);
    if (m !== null) return say(m);
  }
  return reason;
}
