/** Language of the text being linted. */
export type Lang = 'en' | 'es';

/** Language a rule applies to. */
export type RuleLang = Lang | 'both';

/**
 * 1: banned. Any hit is a failure and makes the CLI exit non-zero.
 * 2: budgeted. Hits are tolerated up to a budget (0 when not set), then reported.
 * 3: context word. Ignored when the sentence has an anchor; otherwise it joins the Tier 2 budget.
 */
export type Level = 1 | 2 | 3;

export type Severity = 'disqualify' | 'high' | 'medium' | 'low';

/**
 * Evidence tags as the research report uses them:
 * MEDIDO measured with a primary source, NORMA normative reference (RAE, style manuals),
 * REPORTADO press, blogs or unaudited surveys, CONSENSO editors' common practice,
 * SÍNTESIS the researcher's own conclusion.
 */
export type Evidence = 'MEDIDO' | 'NORMA' | 'REPORTADO' | 'CONSENSO' | 'SÍNTESIS';

export interface Source {
  evidence: readonly Evidence[];
  /** Where the evidence comes from, as the report cites it. */
  ref: string;
  /** Section of the research report that defines the rule. */
  section: string;
}

export interface Example {
  lang: Lang;
  /** Text the rule must flag. */
  fire: string;
  /** A near-miss the rule must leave alone. */
  pass: string;
}

interface RuleBase {
  /** Catalog id from the report (sections 5 and 13). LEX-07, LEX-08 and MED-01 are added here: the report gives those rules without an id. */
  id: string;
  name: string;
  lang: RuleLang;
  level: Level;
  severity: Severity;
  message: string;
  suggestion: string;
  source: Source;
  /** What this implementation changes from the report's regex or threshold, and why. */
  deviation?: string;
  /** Known false positives. */
  falsePositives?: string;
  /**
   * Only meaningful in plain text, where Markdown syntax is shown as typed.
   * Skipped when lint() reads the input as Markdown.
   */
  plainTextOnly?: boolean;
}

export interface PatternRule extends RuleBase {
  kind: 'pattern';
  /** Regex source per language. A 'both' rule may still use one source per language. */
  patterns: Partial<Record<Lang, string>>;
  /**
   * Alternatives that only count in the last two prose sentences, where a closing
   * formula lives ("Overall," in the middle of a letter is an ordinary opener).
   */
  closingPatterns?: Partial<Record<Lang, string>>;
  /** Always contains g and u. Lexical rules use giu; formatting rules drop i when case matters. */
  flags: string;
  /** Level 2: hits tolerated before findings start. Defaults to 0. */
  budget?: number;
  /** Shares the Tier 2 budget (2 per text, no word repeated) instead of a budget of its own. */
  tier2Pool?: boolean;
  /** Not reported when the sentence holds an anchor (number, tool, proper noun, year). */
  anchorExempt?: boolean;
  /** Not reported inside double quotes or «angle quotes». */
  quoteExempt?: boolean;
  /** Only tested against the start of each sentence. */
  sentenceStart?: boolean;
  examples: readonly Example[];
}

export interface StructuralRule extends RuleBase {
  kind: 'structural';
  /** The threshold the check applies, in words, as the report states it. */
  threshold: string;
  examples: readonly Example[];
}

export type Rule = PatternRule | StructuralRule;

export interface Finding {
  ruleId: string;
  level: Level;
  severity: Severity;
  /** UTF-16 offsets into the input, as String.prototype.slice takes them. */
  start: number;
  end: number;
  /** 1-based. */
  line: number;
  /** 1-based, in UTF-16 code units. */
  column: number;
  match: string;
  message: string;
  suggestion: string;
  /** Why a budgeted hit was reported, or the measured value for a structural check. */
  detail?: string;
}

/** How lint() reads its input. */
export type Format = 'text' | 'markdown';

export interface LintOptions {
  lang: Lang;
  /**
   * 'text' (the default) lints the input as typed. 'markdown' first removes code,
   * tables, HTML comments, link URLs and block markers, honors the slop-lint-disable
   * directives, and skips the plainTextOnly rules. Offsets point into the input either way.
   */
  format?: Format;
  /**
   * Extra anchor terms, usually tool and company names taken from the CV
   * (for example "pandas" or "dbt", which are written in lowercase).
   */
  anchors?: readonly string[];
}

export interface LintStats {
  words: number;
  sentences: number;
  /** Sentences that end in . ! ? and have at least 3 words; salutations and signatures are left out. */
  proseSentences: number;
  meanSentenceLength: number | null;
  /** Standard deviation over mean of words per prose sentence; null under 2 sentences. */
  sentenceLengthCV: number | null;
  emDashes: number;
  anchors: number;
  /** Tier 2 words plus Tier 3 words without an anchor. */
  tier2Used: number;
  tier2Budget: number;
}

export interface LintResult {
  lang: Lang;
  findings: Finding[];
  /** True when no level 1 rule fired. */
  passesTier1: boolean;
  /** True when a rule with severity 'disqualify' fired. */
  disqualified: boolean;
  /**
   * The "absence of slop" dimension of the report's rubric (section 10): 15 points,
   * minus 3 per high finding, 1.5 per medium and 0.5 per low; 0 with 3 or more high
   * findings or with a disqualifying one.
   */
  score: { points: number; max: 15 };
  stats: LintStats;
}
