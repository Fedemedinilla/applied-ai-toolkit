import { B, E, wordList } from './regex.ts';
import { NUMBER_WORDS } from './text.ts';
import type { PatternRule, Rule, StructuralRule } from './types.ts';

/**
 * The rule catalog. Every rule keeps the id, threshold, severity, evidence tag and
 * source of the research report (sections 12 and 13). Levels follow the report's
 * columns: a rule with threshold 0 and severity "disqualify" or "high" is level 1;
 * anything with a budget, or with medium or low severity, is level 2; the Tier 3
 * context lists of section 12 are level 3.
 *
 * Regexes are ECMAScript sources compiled with the flags in each rule. The report's
 * \b boundaries were replaced with Unicode-aware lookarounds (see regex.ts), which is
 * a fix as well as a style change: several of its Spanish patterns could not match
 * words that end in an accented vowel.
 */

/**
 * FMT-04's bracket branch: a capital first, then letters and underscores, up to five
 * words, 40 characters at most. "[Company Name]" and "[Nombre de la empresa]" match;
 * "[sic]", "[2023]", "[12]" and "[pandas, numpy]" do not.
 */
const PLACEHOLDER = String.raw`\[(?=[^\]\n]{2,40}\])\p{Lu}[\p{L}_]*(?: [\p{L}_]+){0,4}\]|\{\{[^}\n]+\}\}`;

const WIKI = 'Wikipedia, Signs of AI writing (en.wikipedia.org/wiki/Signs_of_AI_writing)';
const NUM = [...NUMBER_WORDS.en, ...NUMBER_WORDS.es].join('|');
const MONTHS =
  'january|february|march|april|may|june|july|august|september|october|november|december|' +
  'enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre';

const lexical: PatternRule[] = [
  {
    kind: 'pattern',
    id: 'LEX-01',
    name: 'Tier 1 phrases (Spanish)',
    lang: 'es',
    level: 1,
    severity: 'high',
    patterns: {
      es: wordList([
        'me dirijo a (?:usted|ustedes)(?: para)?',
        'por medio de la presente',
        'expresar(?:les?)? mi (?:profundo |sincero |gran )?interés',
        'en el (?:dinámico|cambiante|competitivo) mundo',
        'en el panorama actual',
        'hoy más que nunca',
        'profundizar en',
        'sinergias?',
        'apasionad[oa]s? por',
        'me apasiona(?:n)?',
        'candidat[oa] ideal',
        'sería un honor',
        'estoy emocionad[oa] de',
        '(?:aportar|agregar) (?:un )?(?:gran |verdadero )?valor(?: significativo| agregado)?',
        'un testimonio de',
        'navegar (?:la|las|el|los) (?:complejidad(?:es)?|incertidumbre|desafíos|cambios)',
        'aprovechar mis (?:habilidades|conocimientos|capacidades)',
        'sólido historial',
        'no (?:dudes?|dude) en',
        'quedo a (?:su|tu) (?:entera )?disposición',
        'ponerme la camiseta',
      ]),
    },
    flags: 'giu',
    quoteExempt: true,
    message: 'Template phrase that reads as generated.',
    suggestion: 'Cut it and state the fact it was standing in for: the role, a project, a number.',
    source: { evidence: ['SÍNTESIS'], ref: 'Section 12, Spanish Tier 1 list', section: '12, 13.2' },
    deviation:
      'Adds the section 12 entries missing from the 13.2 extract (en el panorama actual, apasionado por, me apasiona, ' +
      'aprovechar mis habilidades, navegar in a figurative sense) and the variant "aportar un valor significativo" from the ' +
      'section 15 neutral letter. "En resumen" and "en definitiva" are left to EST-05. ' +
      'Proactivo and orientado a resultados are left to ESP-04.',
    examples: [
      { lang: 'es', fire: 'Me dirijo a ustedes para presentar mi candidatura.', pass: 'Me dirijo a la oficina de Rosario los lunes.' },
      { lang: 'es', fire: 'Quedo a su entera disposición.', pass: 'El tablero queda a disposición de los gerentes.' },
    ],
  },
  {
    kind: 'pattern',
    id: 'LEX-02',
    name: 'Tier 2 vocabulary (Spanish)',
    lang: 'es',
    level: 2,
    severity: 'medium',
    tier2Pool: true,
    patterns: {
      es: wordList([
        'crucial(?:es)?',
        String.raw`(?<!palabras? )claves?(?! fiscal)`,
        'fundamental(?:es)?',
        'esencial(?:es)?',
        'sólid[oa]s?',
        'integral(?:es)?',
        'robust[oa]s?',
        'potenci(?:ar|é|ó|ando)',
        'impuls(?:ar|é|ó|ando)',
        'foment(?:ar|é|ó|ando)',
        'destac(?:ar|é|ó|ando)',
        'subray(?:ar|é|ó|ando)',
        'innovador(?:a|es|as)?',
        'dinámic[oa]s?',
        'desafiantes?',
        'enriquecedor(?:a|es|as)?',
        'invaluables?',
        'meticulos[oa]s?',
        'versátil(?:es)?',
        'comprometid[oa]s?',
        'excelencia',
        'asimismo',
        'cabe destacar',
        'de cara a',
        'en pos de',
      ]),
    },
    flags: 'giu',
    message: 'Overused vocabulary. Tolerated twice per text, never the same word twice.',
    suggestion: 'Replace it with the fact or the plain word.',
    source: { evidence: ['SÍNTESIS'], ref: 'Section 12, Spanish Tier 2; Spanish analogues of Kobak et al. 2025', section: '4.1, 12' },
    deviation: 'Verbs also match the first-person and third-person preterite and the gerund, not only the infinitive.',
    falsePositives: '"clave" in "palabra clave" and "clave fiscal" is excluded; "dinámica" as a noun and "integral" in mathematics still match.',
    examples: [
      { lang: 'es', fire: 'Fue un proyecto fundamental para el área.', pass: 'Cargué la palabra clave del aviso.' },
      { lang: 'es', fire: 'Tengo una sólida formación.', pass: 'Solidifiqué la base de clientes.' },
    ],
  },
  {
    kind: 'pattern',
    id: 'LEX-03',
    name: 'Tier 1 phrases (English)',
    lang: 'en',
    level: 1,
    severity: 'high',
    patterns: {
      en: wordList([
        'I am writing to (?:express|apply)',
        'keen interest',
        'delv(?:e|es|ed|ing)',
        'tapestry',
        'testament to',
        String.raw`in today['’]s (?:\p{L}+(?:-\p{L}+)* )?(?:world|landscape|market|environment)`,
        'proven track record',
        'fast-paced environment',
        'hit the ground running',
        'passionate about',
        'leverag(?:e|es|ed|ing) my',
        'synerg(?:y|ies)',
        'game[- ]changers?',
        'unlock(?:s|ed|ing)?',
        'embark(?:s|ed|ing)?',
        'navigat(?:e|ing) the complexities',
        'ideal (?:candidate|fit)',
        String.raw`I(?:['’]m| am) confident that (?:I(?:['’]d| would) be|my [\p{L} ]{1,40}makes? me) (?:a|an|the) (?:great|ideal|perfect|strong) fit`,
      ]),
    },
    flags: 'giu',
    quoteExempt: true,
    message: 'Banned cover-letter phrase.',
    suggestion: 'Replace it with a fact from the CV: a project, a tool, a number, a year.',
    source: {
      evidence: ['MEDIDO', 'CONSENSO'],
      ref: 'Kobak et al. 2025, Science Advances (arxiv.org/pdf/2406.07016); section 12, English Tier 1',
      section: '4.1, 12, 13.2',
    },
    deviation:
      'Generalizes "I am confident that I would be a great fit" to its common variants and adds "ideal fit". ' +
      '"Thank you for your time and consideration" is Tier 1 only as the sole closing line, which needs the letter structure; not implemented.',
    falsePositives: '"unlock" and "embark" in their literal sense.',
    examples: [
      { lang: 'en', fire: 'I have a proven track record in retail analytics.', pass: 'We tracked a record number of orders in 2023.' },
      { lang: 'en', fire: 'Let me delve into the details.', pass: 'The delivery team shipped it in May.' },
      { lang: 'en', fire: "In today's fast-paced world, data matters.", pass: 'Today I shipped the report.' },
    ],
  },
  {
    kind: 'pattern',
    id: 'LEX-04',
    name: 'Tier 2 vocabulary (English)',
    lang: 'en',
    level: 2,
    severity: 'medium',
    tier2Pool: true,
    patterns: {
      en: wordList([
        'crucial',
        'pivotal',
        'robust',
        'comprehensive',
        'seamless(?:ly)?',
        'enhanc(?:e|es|ed|ing)',
        'foster(?:s|ed|ing)?',
        'align(?:s|ed|ing)? with',
        'highlight(?:s|ed|ing)?',
        'showcas(?:e|es|ed|ing)',
        'underscor(?:e|es|ed|ing)',
        'meticulous(?:ly)?',
        'intricate',
        'commendable',
        'innovative',
        'dynamic',
        'invaluable',
        'additionally',
        'moreover',
        'furthermore',
        'ultimately',
        'key (?:role|player|skills?|insights?|drivers?|factors?|strengths?|areas?|aspects?|takeaways?)',
      ]),
    },
    flags: 'giu',
    message: 'Excess style vocabulary. Tolerated twice per text, never the same word twice.',
    suggestion: 'Use the plain verb or the fact.',
    source: {
      evidence: ['MEDIDO'],
      ref: 'Liang et al. 2024, ICML (arxiv.org/html/2403.07183v2); Kobak et al. 2025',
      section: '4.1, 12, 13.2',
    },
    deviation: '"key" from the section 12 list only matches before a small set of abstract nouns, so "API key" does not count.',
    examples: [
      { lang: 'en', fire: 'This was a pivotal year for the team.', pass: 'I built the pivot table in an hour.' },
      { lang: 'en', fire: 'Additionally, I wrote the docs.', pass: 'I added two columns to the report.' },
    ],
  },
  {
    kind: 'pattern',
    id: 'LEX-05',
    name: 'Intensifiers',
    lang: 'both',
    level: 2,
    severity: 'low',
    budget: 1,
    patterns: {
      en: wordList(['really', 'truly', 'deeply', 'incredibly', 'extremely', 'highly', 'genuinely']),
      es: wordList([
        'realmente', 'verdaderamente', 'sumamente', 'altamente', 'increíblemente', 'extremadamente', 'profundamente', 'genuinamente',
      ]),
    },
    flags: 'giu',
    message: 'Intensifier. One can be voice; two are a tic.',
    suggestion: 'Delete it.',
    source: { evidence: ['SÍNTESIS'], ref: 'Section 3 audit of the earlier rule set', section: '3, 13.2' },
    examples: [
      { lang: 'en', fire: 'I am truly excited about the role.', pass: 'That figure is true for 2024.' },
      { lang: 'es', fire: 'Estoy realmente interesada.', pass: 'La realidad del área es otra.' },
    ],
  },
  {
    kind: 'pattern',
    id: 'LEX-06',
    name: 'Self-proclaimed honesty or humility',
    lang: 'both',
    level: 1,
    severity: 'high',
    patterns: {
      en: wordList(['to be (?:honest|frank)', 'honestly', 'let me be (?:clear|candid)', 'no fluff', 'humbly']),
      es: wordList([
        'para ser (?:sincer[oa]|honest[oa]|franc[oa])',
        'te lo digo como es',
        'sin rodeos',
        'nada se inventa',
        'con total transparencia',
        'humildemente',
      ]),
    },
    flags: 'giu',
    quoteExempt: true,
    message: 'Announcing honesty adds nothing when the letter is true and makes it worse when it is not.',
    suggestion: 'Delete it.',
    source: { evidence: ['CONSENSO'], ref: 'Section 3 audit; section 12', section: '3, 12, 13.2' },
    examples: [
      { lang: 'en', fire: 'To be honest, I have not used Looker.', pass: 'I was honest about the gap.' },
      { lang: 'es', fire: 'Para ser sincera, no usé dbt.', pass: 'Fui sincera sobre lo que falta.' },
    ],
  },
  {
    kind: 'pattern',
    id: 'LEX-07',
    name: 'Tier 3 context words (Spanish)',
    lang: 'es',
    level: 3,
    severity: 'medium',
    patterns: {
      es: wordList([
        'equipos?', 'impactos?', 'lider(?:ar|é|ó|ando|azgo)', 'desafíos?', 'resultados?', 'experiencias?', 'habilidades',
        'crecimiento', 'aprendizaje', 'motivación', 'feedback', 'rol(?:es)?', 'expertise',
      ]),
    },
    flags: 'giu',
    message: 'Context word without an anchor in its sentence. It counts against the Tier 2 budget.',
    suggestion: 'Put a number, a tool, a name or a year in the same sentence, or cut the word.',
    source: { evidence: ['SÍNTESIS'], ref: 'Section 12, Tier 3 decision rule', section: '12' },
    deviation: 'The report lists these words without an id; LEX-07 is this implementation\'s id.',
    examples: [
      { lang: 'es', fire: 'Me gusta el trabajo en equipo.', pass: 'Compré equipamiento para la oficina.' },
    ],
  },
  {
    kind: 'pattern',
    id: 'LEX-08',
    name: 'Tier 3 context words (English)',
    lang: 'en',
    level: 3,
    severity: 'medium',
    patterns: {
      en: wordList([
        'teams?', 'impact(?:s|ful)?', 'lead(?:s|ing)?', 'led', 'challenges?', 'results?', 'driv(?:e|es|ing)', 'drove',
        'collaborat(?:e|es|ed|ing|ion)', 'stakeholders?', 'ownership',
      ]),
    },
    flags: 'giu',
    message: 'Context word without an anchor in its sentence. It counts against the Tier 2 budget.',
    suggestion: 'Put a number, a tool, a name or a year in the same sentence, or cut the word.',
    source: { evidence: ['SÍNTESIS'], ref: 'Section 12, Tier 3 decision rule', section: '12' },
    deviation: 'The report lists these words without an id; LEX-08 is this implementation\'s id.',
    examples: [{ lang: 'en', fire: 'I love working with the team.', pass: 'I teamed up with finance.' }],
  },
];

const specificity: PatternRule[] = [
  {
    kind: 'pattern',
    id: 'ESP-01',
    name: 'Inflated quantity (candidate for the judge)',
    lang: 'both',
    level: 2,
    severity: 'medium',
    patterns: {
      en: `${B}(?:over|more than|nearly|almost|close to)\\s+(?:\\d+|${NUMBER_WORDS.en.join('|')})${E}`,
      es: `${B}(?:más de|cerca de|casi)\\s+(?:\\d+|${NUMBER_WORDS.es.join('|')})${E}`,
    },
    flags: 'giu',
    message: 'Rounded-up quantity. In the rubric an inflated figure disqualifies the letter, but only the CV can confirm it.',
    suggestion: 'Use the exact figure from the CV: "four years", "since 2022".',
    source: { evidence: ['SÍNTESIS'], ref: 'Section 1.4; rubric disqualifiers, section 10', section: '1.4, 10, 13.2' },
    deviation:
      'The report rates ESP-01 as disqualifying. A regex cannot see the CV, so here it is a level 2 candidate for the ' +
      'model judge. Spelled-out numbers match too ("más de cuatro años", from the section 15 letter).',
    falsePositives: '"over three days" as a duration.',
    examples: [
      { lang: 'es', fire: 'Tengo más de cuatro años de experiencia.', pass: 'Tengo cuatro años de experiencia.' },
      { lang: 'en', fire: 'I have more than 5 years in retail.', pass: 'I have 5 years in retail.' },
    ],
  },
  {
    kind: 'pattern',
    id: 'ESP-04',
    name: 'Self-assessment without proof',
    lang: 'both',
    level: 1,
    severity: 'high',
    anchorExempt: true,
    quoteExempt: true,
    patterns: {
      en: wordList(['proactive', 'passionate', 'results-driven', 'detail-oriented', 'self-starter']),
      es: wordList(['proactiv[oa]s?', 'apasionad[oa]s?', 'orientad[oa]s? a resultados', 'resilientes?', 'detallistas?']),
    },
    flags: 'giu',
    message: 'Character adjective with no fact in the sentence to back it.',
    suggestion: 'Show the trait with a fact from the CV, or cut it.',
    source: { evidence: ['CONSENSO'], ref: 'Sections 1.4 and 13.1', section: '1.4, 13.2' },
    examples: [
      { lang: 'es', fire: 'Soy una persona proactiva.', pass: 'Valoro la proactividad del área.' },
      { lang: 'en', fire: 'I am a results-driven analyst.', pass: 'The results drove a second release.' },
    ],
  },
];

const structure: PatternRule[] = [
  {
    kind: 'pattern',
    id: 'EST-01',
    name: 'Negative parallelism',
    lang: 'both',
    level: 1,
    severity: 'high',
    patterns: {
      es:
        String.raw`(?<![\p{L}])no (?:es|son|era|fue|se trata de)(?: (?:solo|sólo|solamente|simplemente))?[^.;!?\n]{1,60}[,:;—–]\s*(?:es|son|sino|se trata de)(?![\p{L}])` +
        String.raw`|(?<![\p{L}])no (?:es|son|era|fue) (?:solo|sólo|solamente|simplemente) [^.!?\n]{1,60}[.!]\s+(?:es|son|era|fue)(?![\p{L}])`,
      en:
        String.raw`(?<![\p{L}])(?:(?:it['’]s|it is|this is|that['’]s|they['’]re|it was) not|isn['’]t|aren['’]t|wasn['’]t)` +
        String.raw`(?: (?:just|only|merely)[^.;!?\n]{1,60}[,:;—–]\s*(?:it['’]s|it is|they['’]re|this is|but)|[^.;!?\n]{1,60}[,:;—–]\s*(?:it['’]s|it is|they['’]re|this is))(?![\p{L}])` +
        String.raw`|(?<![\p{L}])(?:it['’]s|it is|this is|that['’]s) not (?:just|only|merely) [^.!?\n]{1,60}[.!]\s+(?:it['’]s|it is|this is|that['’]s)(?![\p{L}])`,
    },
    flags: 'giu',
    message: 'Negative parallelism ("not X, it is Y"), one of the most durable signs of generated text.',
    suggestion: 'State Y directly, with the fact that supports it.',
    source: { evidence: ['REPORTADO'], ref: WIKI, section: '4.2, 13.2' },
    deviation:
      'In English, a plain "it\'s not X, but Y" only fires with just/only/merely; without them it is an ordinary contrast. ' +
      'Adds the two-sentence form ("This is not just a tool. It\'s a platform."), which the report\'s one-sentence regex misses, ' +
      'only with just/only/merely (solo/simplemente). Line breaks end the match.',
    examples: [
      { lang: 'es', fire: 'Los datos no son solo números: son la clave.', pass: 'Los datos no son públicos.' },
      { lang: 'en', fire: "It's not just a job, it's a calling.", pass: "It's not cheap, but it pays for itself in a month." },
      { lang: 'en', fire: "This is not just a tool. It's a platform.", pass: "This is not a tool. It's a script I wrote in 2023." },
      { lang: 'es', fire: 'No es solo un tablero. Es una forma de pensar.', pass: 'No es un tablero. Es una planilla de 2023.' },
    ],
  },
  {
    kind: 'pattern',
    id: 'EST-02',
    name: '"Not only... but also"',
    lang: 'both',
    level: 2,
    severity: 'medium',
    patterns: {
      es: String.raw`(?<![\p{L}])no s[oó]lo(?![\p{L}])[^.\n]{1,80}(?<![\p{L}])sino(?: también| que)?(?![\p{L}])`,
      en: String.raw`(?<![\p{L}])not only(?![\p{L}])[^.\n]{1,80}(?<![\p{L}])but also(?![\p{L}])`,
    },
    flags: 'giu',
    message: 'Additive template.',
    suggestion: 'Write two sentences, each with its fact.',
    source: { evidence: ['REPORTADO'], ref: WIKI, section: '4.2, 13.2' },
    examples: [
      { lang: 'en', fire: 'The script was not only faster but also cheaper.', pass: 'The script runs not only on weekdays.' },
      { lang: 'es', fire: 'No solo optimicé procesos sino que también capacité al equipo.', pass: 'No solo eso: también cambió el horario.' },
    ],
  },
  {
    kind: 'pattern',
    id: 'EST-03',
    name: 'Abstract triad',
    lang: 'both',
    level: 2,
    severity: 'medium',
    budget: 1,
    patterns: {
      es: String.raw`(?<![\p{L}])\p{L}+(?:ción|sión|dad|miento|ncia|ismo)\s*,\s*\p{L}+(?:ción|sión|dad|miento|ncia|ismo)\s*,?\s*(?:y|e)\s+\p{L}+(?:ción|sión|dad|miento|ncia|ismo)(?![\p{L}])`,
      en: String.raw`(?<![\p{L}])\p{L}+(?:tion|sion|ity|ness|ment|ence|ance|ism)\s*,\s*\p{L}+(?:tion|sion|ity|ness|ment|ence|ance|ism)\s*,?\s*and\s+\p{L}+(?:tion|sion|ity|ness|ment|ence|ance|ism)(?![\p{L}])`,
    },
    flags: 'giu',
    message: 'Three abstract nouns in a row. One per text is tolerated; lists of concrete tools do not count.',
    suggestion: 'Replace the triad with one fact.',
    source: { evidence: ['CONSENSO', 'SÍNTESIS'], ref: 'Wikipedia talk, Signs of AI writing, Archive 4', section: '3, 4.2, 13.2' },
    deviation: 'Suffixes split per language (the report uses one mixed list), and English adds -sion, -ance and -ism.',
    falsePositives: 'A triad of concrete nouns that happen to share the suffixes ("facturación, conciliación y liquidación" as real tasks). The judge confirms.',
    examples: [
      { lang: 'en', fire: 'We value innovation, collaboration, and excellence.', pass: 'I used SQL, Python, and Power BI.' },
      { lang: 'es', fire: 'Aporto dedicación, responsabilidad y excelencia.', pass: 'Uso SQL, Python y Power BI.' },
    ],
  },
  {
    kind: 'pattern',
    id: 'EST-04',
    name: 'Throat-clearing opener',
    lang: 'both',
    level: 1,
    severity: 'high',
    sentenceStart: true,
    patterns: {
      es: String.raw`^(?:En (?:el|un) (?:mundo|panorama|contexto|entorno|mercado) (?:actual|de hoy|cada vez más)|En el (?:dinámico|cambiante|competitivo) mundo|Hoy (?:en día|más que nunca)|Es importante (?:destacar|señalar|mencionar)|Cabe (?:destacar|señalar|mencionar))(?![\p{L}])`,
      en: String.raw`^(?:In today['’]s|In an ever|In the (?:ever-)?(?:evolving|changing|fast-paced) (?:world|landscape)|It is important to (?:note|mention|highlight)|It['’]s (?:worth noting|important to note))(?![\p{L}])`,
    },
    flags: 'giu',
    message: 'The sentence prepares to say something instead of saying it.',
    suggestion: 'Start with the role and the proof.',
    source: { evidence: ['CONSENSO'], ref: 'Sections 1.1 and 4.2', section: '4.2, 13.2' },
    deviation: 'The report checks only the first sentence; here every sentence start is checked, because the phrases are no better in the middle of a letter.',
    examples: [
      { lang: 'es', fire: 'Hoy en día los datos lo son todo.', pass: 'Hoy cerré el reporte de octubre.' },
      { lang: 'en', fire: 'It is important to note that I know SQL.', pass: 'It is a SQL Server shop.' },
    ],
  },
  {
    kind: 'pattern',
    id: 'EST-05',
    name: 'Summary closer',
    lang: 'both',
    level: 1,
    severity: 'high',
    patterns: {
      es: wordList(['en resumen', 'en definitiva', 'en conclusión', 'en síntesis', 'para concluir']),
      en: wordList(['in summary', 'in conclusion', 'to sum up']),
    },
    closingPatterns: {
      en: String.raw`(?<![\p{L}])(?:overall|ultimately),`,
    },
    flags: 'giu',
    quoteExempt: true,
    message: 'Closing formula that repeats what was already said.',
    suggestion: 'Close with a concrete request: a call, a date, a demo.',
    source: { evidence: ['REPORTADO'], ref: 'erkansaka.net summary of Wikipedia, Signs of AI writing', section: '4.2, 13.2' },
    deviation:
      '"Overall," and "ultimately," open ordinary sentences in the middle of a letter, so they only count in the last two ' +
      'prose sentences. Elsewhere "ultimately" is still a Tier 2 word (LEX-04). The other phrases count anywhere.',
    falsePositives: '"Overall, the project shipped on time." as the last fact of a letter that then closes with a request in one sentence.',
    examples: [
      { lang: 'es', fire: 'En resumen, soy la candidata ideal.', pass: 'Escribí el resumen del cierre mensual.' },
      { lang: 'en', fire: 'I built the report. Overall, I am a strong fit.', pass: 'The overall cost fell 12% in 2023.' },
      {
        lang: 'en',
        fire: 'In conclusion, I fit the role.',
        pass: 'I wrote the 12 reports. Overall, the cost fell 12% in 2023. I documented it. I want the role.',
      },
    ],
  },
  {
    kind: 'pattern',
    id: 'EST-07',
    name: 'False range',
    lang: 'both',
    level: 2,
    severity: 'low',
    patterns: {
      es: String.raw`(?<![\p{L}])desde\s+(?!\d|(?:${NUM}|${MONTHS})(?![\p{L}]))[^,.;\n]{2,40}\s+hasta\s+(?!\d|(?:${NUM}|${MONTHS})(?![\p{L}]))`,
      en: String.raw`(?<![\p{L}])from\s+(?!\d|(?:${NUM}|${MONTHS})(?![\p{L}]))[^,.;\n]{2,40}\s+to\s+(?!\d|(?:${NUM}|${MONTHS})(?![\p{L}]))`,
    },
    flags: 'giu',
    message: '"From X to Y" with abstract ends, which suggests a scale that does not exist.',
    suggestion: 'List what was actually done.',
    source: { evidence: ['REPORTADO'], ref: WIKI, section: '4.2, 13.2' },
    deviation: 'Number words and month names are excluded at both ends, as the report allows dates and figures.',
    falsePositives: '"from the office to the client" and other literal movement.',
    examples: [
      { lang: 'en', fire: 'I handle everything from analysis to strategy.', pass: 'It went from three days to four hours.' },
      { lang: 'es', fire: 'Cubro desde el análisis hasta la estrategia.', pass: 'Trabajé desde marzo hasta octubre.' },
    ],
  },
  {
    kind: 'pattern',
    id: 'EST-08',
    name: 'Participle tail',
    lang: 'both',
    level: 2,
    severity: 'medium',
    patterns: {
      es:
        String.raw`(?<![\p{L}])\p{L}+(?:é|ó|aron|ieron)(?![\p{L}])[^.;\n]{0,80},\s+\p{L}+(?:ando|iendo|yendo)(?![\p{L}])` +
        String.raw`|[,—–]\s*(?:\p{L}+mente\s+)?(?:logrando|consiguiendo|permitiendo|generando|obteniendo|alcanzando|garantizando|asegurando|fomentando|impulsando|contribuyendo|mejorando|optimizando|reduciendo|aumentando|aportando|demostrando|siendo)(?![\p{L}])`,
      en:
        String.raw`(?<![\p{L}])\p{L}+ed(?![\p{L}])[^.;\n]{0,80},\s+\p{L}+ing(?![\p{L}])` +
        String.raw`|[,—–]\s*(?:\p{L}+ly\s+)?(?:ensuring|fostering|driving|enabling|delivering|resulting in|leading to|contributing to|highlighting|underscoring|showcasing|reflecting|demonstrating|cutting|reducing|improving|increasing|boosting|saving)(?![\p{L}])`,
    },
    flags: 'giu',
    message: 'Gerund or participle tail that tacks a consequence onto the sentence.',
    suggestion: 'Give the result its own clause: "; so the close went from 3 days to 4 hours".',
    source: { evidence: ['NORMA', 'SÍNTESIS'], ref: 'NGLE (RAE/ASALE) on the gerund of posteriority; section 5.1', section: '4.2, 13.2' },
    deviation:
      'The report\'s pattern uses \\b after é and ó, which never matches in JavaScript, and it needs a past tense verb before the comma. ' +
      'Both versions miss the section 15 examples ("…visualización, logrando optimizar", and "consistently delivering" after a dash). ' +
      'This version fixes the boundary and adds a list of consequence gerunds after a comma or dash.',
    falsePositives:
      'Gerunds of simultaneous manner ("Trabajé en Rosario, viviendo en Funes"), and "-ing" nouns after a past verb ("I worked on X, including Y"). ' +
      'That is why it is level 2 and the judge decides.',
    examples: [
      { lang: 'es', fire: 'Automaticé el cierre, logrando reducir tiempos.', pass: 'Automaticé el cierre: pasó de tres días a cuatro horas.' },
      { lang: 'en', fire: 'I rebuilt the pipeline, ensuring data quality.', pass: 'I rebuilt the pipeline in 2023.' },
    ],
  },
  {
    kind: 'pattern',
    id: 'EST-09',
    name: 'Process narration',
    lang: 'both',
    level: 2,
    severity: 'medium',
    patterns: {
      es: wordList(['tras (?:analizar|revisar|leer)', '(?:después|luego) de (?:analizar|revisar|leer)']),
      en: wordList(['after (?:reviewing|analyzing|reading)', 'having (?:reviewed|read)', 'upon (?:review|closer)']),
    },
    flags: 'giu',
    message: 'Narrates the writing process. The fact does not need an escort.',
    suggestion: 'Delete the clause and keep the fact.',
    source: { evidence: ['REPORTADO'], ref: 'Wikipedia talk, Signs of AI writing, Archive 8', section: '1.2, 4.2, 13.2' },
    examples: [
      { lang: 'en', fire: 'After reviewing the job description, I believe I fit.', pass: 'I review the job board every morning.' },
      { lang: 'es', fire: 'Tras analizar la oferta, considero que encajo.', pass: 'Analicé la oferta de stock por sucursal.' },
    ],
  },
];

const rhetoric: PatternRule[] = [
  {
    kind: 'pattern',
    id: 'RET-01',
    name: 'Flattery without a fact',
    lang: 'both',
    level: 2,
    severity: 'medium',
    anchorExempt: true,
    patterns: {
      es: wordList([
        'una empresa (?:tan )?(?:innovadora|líder|prestigiosa|reconocida)',
        '(?:su|esta|una|tan) (?:prestigiosa|reconocida|innovadora|destacada) (?:empresa|organización|compañía)',
      ]),
      en: wordList([
        'such an? (?:innovative|prestigious|leading) (?:company|organization|team)',
        'your (?:prestigious|innovative|esteemed) (?:company|organization|firm)',
      ]),
    },
    flags: 'giu',
    message: 'Praise for the company with nothing the candidate knows about it.',
    suggestion: 'Name a product, a public figure or a dated news item, or cut the praise.',
    source: { evidence: ['SÍNTESIS'], ref: 'Section 4.3', section: '4.3, 13.2' },
    deviation: 'Adds "su prestigiosa organización" and its variants, from the section 15 neutral letter.',
    examples: [
      { lang: 'es', fire: 'Quiero sumarme a una empresa tan innovadora.', pass: 'La empresa abrió la sucursal de Salta.' },
      { lang: 'en', fire: 'I would love to join such an innovative company.', pass: 'The company is hiring two analysts.' },
    ],
  },
  {
    kind: 'pattern',
    id: 'RET-03',
    name: 'Vague attribution',
    lang: 'both',
    level: 2,
    severity: 'medium',
    patterns: {
      es: wordList(['los expertos (?:coinciden|afirman)', '(?:diversos|numerosos) estudios', 'se sabe que']),
      en: wordList(['experts agree', 'studies show', 'it is widely (?:known|recognized)']),
    },
    flags: 'giu',
    message: 'Attribution without a source.',
    suggestion: 'Name the source or cut the claim.',
    source: { evidence: ['REPORTADO'], ref: WIKI, section: '1.2, 4.3, 13.2' },
    examples: [
      { lang: 'en', fire: 'Studies show that dashboards help.', pass: 'The 2023 study showed a drop.' },
      { lang: 'es', fire: 'Numerosos estudios lo confirman.', pass: 'Un estudio de 2024 lo midió.' },
    ],
  },
  {
    kind: 'pattern',
    id: 'RET-04',
    name: 'Excessive hedging',
    lang: 'both',
    level: 2,
    severity: 'low',
    budget: 1,
    patterns: {
      es: wordList(['podría quizás', 'tal vez podría']),
      en: wordList(['might potentially', 'could possibly', 'may perhaps']),
    },
    flags: 'giu',
    message: 'Stacked hedges.',
    suggestion: 'Say it or leave it out.',
    source: { evidence: ['CONSENSO'], ref: 'Section 4.3', section: '4.3, 13.2' },
    examples: [
      { lang: 'en', fire: 'I could possibly help with Looker.', pass: 'I could help with Looker.' },
      { lang: 'es', fire: 'Podría quizás sumar algo.', pass: 'Podría sumar el tablero.' },
    ],
  },
];

const format: PatternRule[] = [
  {
    kind: 'pattern',
    id: 'FMT-01',
    name: 'Markdown in plain text',
    lang: 'both',
    level: 1,
    severity: 'high',
    patterns: {
      en: String.raw`\*\*[^*\n]+\*\*|__[^_\n]+__|^#{1,6}[ \t]|^[ \t]*(?:[-*•]|\d+[.)])[ \t]+`,
      es: String.raw`\*\*[^*\n]+\*\*|__[^_\n]+__|^#{1,6}[ \t]|^[ \t]*(?:[-*•]|\d+[.)])[ \t]+`,
    },
    flags: 'gmu',
    message: 'Markdown in a plain-text field. A portal shows the asterisks and hashes as typed.',
    suggestion: 'Write it as plain prose.',
    source: { evidence: ['REPORTADO'], ref: 'Wikipedia, Signs of AI writing, October 2026', section: '4.4, 13.2' },
    deviation: '\\s became [ \\t] so a match cannot run across lines.',
    falsePositives: 'A PDF with its own layout, where lists are legitimate. Lint the portal version.',
    plainTextOnly: true,
    examples: [
      { lang: 'en', fire: 'I use **Python** daily.', pass: 'I use Python daily.' },
      { lang: 'es', fire: '- Power BI\n- SQL', pass: 'Power BI y SQL.' },
    ],
  },
  {
    kind: 'pattern',
    id: 'FMT-02',
    name: 'Emoji',
    lang: 'both',
    level: 1,
    severity: 'high',
    patterns: {
      en: String.raw`(?![©®™])\p{Extended_Pictographic}`,
      es: String.raw`(?![©®™])\p{Extended_Pictographic}`,
    },
    flags: 'gu',
    message: 'Emoji in a cover letter.',
    suggestion: 'Delete it.',
    source: { evidence: ['CONSENSO'], ref: 'Section 4.4', section: '4.4, 13.2' },
    deviation: '© ® and ™ belong to Extended_Pictographic but are not emoji; they are excluded.',
    examples: [{ lang: 'en', fire: 'Excited to apply 🚀', pass: 'Power BI® dashboard' }],
  },
  {
    kind: 'pattern',
    id: 'FMT-03',
    name: 'Title Case (Spanish)',
    lang: 'es',
    level: 2,
    severity: 'medium',
    patterns: { es: String.raw`^(?:\p{Lu}\p{Ll}+[ \t]+){2,}\p{Lu}\p{Ll}+[ \t]*$` },
    flags: 'gmu',
    message: 'Every word capitalized, copied from English. Spanish capitalizes only the first word and proper nouns.',
    suggestion: '"Analista de datos senior".',
    source: { evidence: ['NORMA'], ref: 'RAE, Ortografía 2010', section: '4.4, 13.2' },
    deviation: 'No i flag, since it would make \\p{Lu} match lowercase letters. \\s became [ \\t].',
    falsePositives: 'Three-word proper names ("Universidad Nacional Rosario", "María José Ferreyra"). Fixable with a list of names from the CV.',
    examples: [
      { lang: 'es', fire: 'Analista De Datos Senior', pass: 'Analista de datos senior' },
      { lang: 'es', fire: 'Ingeniera De Datos Junior', pass: 'ingeniera de datos junior' },
    ],
  },
  {
    kind: 'pattern',
    id: 'FMT-04',
    name: 'Unfilled placeholder or chat residue',
    lang: 'both',
    level: 1,
    severity: 'disqualify',
    patterns: {
      en: `${PLACEHOLDER}|<[A-Z_ ]{3,}>|(?<![\\p{L}])[Aa]s an AI(?: language model)?(?![\\p{L}])`,
      es: `${PLACEHOLDER}|<[A-ZÁÉÍÓÚÑ_ ]{3,}>|(?<![\\p{L}])[Cc]omo (?:un )?modelo de lenguaje|(?<![\\p{L}])[Cc]omo una IA(?![\\p{L}])`,
    },
    flags: 'gu',
    message: 'Template placeholder or chat residue. The rubric disqualifies the letter.',
    suggestion: 'Fill in the value or delete the line.',
    source: { evidence: ['SÍNTESIS'], ref: 'Sections 1.4 and 10', section: '1.4, 10, 13.2' },
    deviation:
      'The report\'s bracket branch, \\[[^\\]\\n]{2,40}\\], matches any bracketed text, so "[sic]", "[2023]" or a ' +
      'citation "[12]" would disqualify a letter. Here a bracket only counts when it looks like a placeholder: a capital ' +
      'first, letters, spaces and underscores only, at most five words. ' +
      'Compiled without i: with it, <[A-Z ]{3,}> also matches HTML tags such as <div>. ' +
      '"como IA" became "como una IA" so that "uso Claude como IA de apoyo" does not disqualify a letter.',
    falsePositives:
      'A capitalized aside in brackets ("[Translated from Portuguese]") and a Markdown link label ("[Design decisions](#x)"). ' +
      'Lint plain text, not Markdown.',
    examples: [
      { lang: 'en', fire: 'I am excited to join [Company Name].', pass: 'I am excited to join Northwind Analytics.' },
      { lang: 'en', fire: 'Dear [HIRING_MANAGER],', pass: 'My thesis [sic] was on SQL [2023], with Python [pandas, numpy].' },
      { lang: 'en', fire: 'Hello <FIRST NAME>,', pass: 'I replaced every <div> with a <section>.' },
      { lang: 'es', fire: 'Me postulo a [Nombre de la empresa].', pass: 'Mi tesis [en prensa] fue sobre SQL.' },
      { lang: 'es', fire: 'Como modelo de lenguaje, no puedo opinar.', pass: 'Entrené un modelo de pronóstico de stock.' },
    ],
  },
];

const spanishOrthography: PatternRule[] = [
  {
    kind: 'pattern',
    id: 'ORT-02',
    name: 'English quotes in Spanish',
    lang: 'es',
    level: 2,
    severity: 'low',
    patterns: { es: '[“”"]' },
    flags: 'gu',
    message: 'Spanish norm prefers «angle quotes» first.',
    suggestion: 'Use «» unless the portal mangles them.',
    source: { evidence: ['NORMA'], ref: 'RAE, Ortografía 2010', section: '13.2' },
    examples: [{ lang: 'es', fire: 'Lo llamamos "cierre".', pass: 'Lo llamamos «cierre».' }],
  },
  {
    kind: 'pattern',
    id: 'ORT-03',
    name: 'Dash glued between words (Spanish)',
    lang: 'es',
    level: 2,
    severity: 'medium',
    patterns: { es: String.raw`\p{L}—\p{L}` },
    flags: 'gu',
    message: 'A raya between two words has no normative use in Spanish; it is the English em dash copied over.',
    suggestion: 'Use a comma, a colon or parentheses.',
    source: { evidence: ['NORMA'], ref: 'RAE, Diccionario panhispánico de dudas, "raya" (rae.es/dpd/raya)', section: '3, 13.2' },
    examples: [{ lang: 'es', fire: 'Convierto datos—decisiones.', pass: 'Convierto datos en decisiones.' }],
  },
  {
    kind: 'pattern',
    id: 'ORT-06',
    name: 'Accents removed in 2010',
    lang: 'es',
    level: 2,
    severity: 'low',
    patterns: { es: wordList(['guión', 'guiónes', 'truhán', 'rió', 'lió', 'fié']) },
    flags: 'giu',
    message: 'Monosyllables that lost the accent in the 2010 Ortografía.',
    suggestion: '"guion", "rio", "lio".',
    source: { evidence: ['NORMA'], ref: 'RAE, Ortografía 2010', section: '13.2' },
    falsePositives: '"Rió" also names a place in some texts. "Sólo" is optional under the norm and not checked.',
    examples: [{ lang: 'es', fire: 'Escribí el guión del video.', pass: 'Escribí el guion del video.' }],
  },
];

const spanishGrammar: PatternRule[] = [
  {
    kind: 'pattern',
    id: 'SIN-01',
    name: 'Dequeísmo',
    lang: 'es',
    level: 1,
    severity: 'high',
    patterns: {
      es: wordList([
        '(?:pienso|creo|opino|considero|supongo|imagino|me parece|resulta|es posible|es necesario|es probable) de que',
      ]),
    },
    flags: 'giu',
    message: '"de que" where the verb takes "que".',
    suggestion: '"Pienso que".',
    source: { evidence: ['NORMA'], ref: 'RAE, Diccionario panhispánico de dudas', section: '13.2' },
    examples: [{ lang: 'es', fire: 'Pienso de que puedo aportar.', pass: 'Me alegro de que hayas venido.' }],
  },
  {
    kind: 'pattern',
    id: 'SIN-02',
    name: 'Queísmo',
    lang: 'es',
    level: 2,
    severity: 'medium',
    patterns: {
      es: wordList([
        '(?:me (?:acuerdo|di cuenta|enteré|olvidé)|estoy (?:segur[oa]|convencid[oa])|tengo la (?:seguridad|certeza)|a pesar|en caso|a fin|con el fin) que',
      ]),
    },
    flags: 'giu',
    message: 'Missing "de" before "que".',
    suggestion: '"Me di cuenta de que".',
    source: { evidence: ['NORMA'], ref: 'RAE, Diccionario panhispánico de dudas', section: '13.2' },
    examples: [{ lang: 'es', fire: 'Me di cuenta que faltaba un índice.', pass: 'Me di cuenta de que faltaba un índice.' }],
  },
  {
    kind: 'pattern',
    id: 'SIN-05',
    name: 'Periphrastic passive',
    lang: 'es',
    level: 2,
    severity: 'low',
    budget: 1,
    patterns: { es: String.raw`(?<![\p{L}])(?:fue|fueron|ha sido|han sido|será|serán)\s+\p{L}+(?:ad|id)[oa]s?\s+por(?![\p{L}])` },
    flags: 'giu',
    message: 'Passive with "por": the agent hides behind the verb.',
    suggestion: 'Make the person the subject: "desarrollé".',
    source: { evidence: ['CONSENSO'], ref: 'Section 1.1, item 11', section: '13.2' },
    examples: [{ lang: 'es', fire: 'El tablero fue desarrollado por mí.', pass: 'Desarrollé el tablero.' }],
  },
  {
    kind: 'pattern',
    id: 'SIN-06',
    name: '"En base a"',
    lang: 'es',
    level: 2,
    severity: 'low',
    patterns: { es: wordList(['en base a']) },
    flags: 'giu',
    message: 'Discouraged phrase.',
    suggestion: '"A partir de", "con base en", "según".',
    source: { evidence: ['NORMA'], ref: 'RAE, Diccionario panhispánico de dudas, "base"', section: '13.2' },
    examples: [{ lang: 'es', fire: 'Decido en base a datos.', pass: 'Decido a partir de datos.' }],
  },
  {
    kind: 'pattern',
    id: 'SIN-07',
    name: '"A nivel de" without a level',
    lang: 'es',
    level: 2,
    severity: 'low',
    patterns: { es: String.raw`(?<![\p{L}])a nivel (?:de )?(?!del mar|freático)\p{L}+` },
    flags: 'giu',
    message: '"A nivel de" where nothing is being leveled.',
    suggestion: '"En el equipo", "para el área".',
    source: { evidence: ['NORMA'], ref: 'RAE, Diccionario panhispánico de dudas, "nivel"', section: '13.2' },
    falsePositives: 'A real hierarchy ("a nivel gerencial" in an org chart).',
    examples: [{ lang: 'es', fire: 'Mejoró mucho a nivel de equipo.', pass: 'La planta está a nivel del mar.' }],
  },
  {
    kind: 'pattern',
    id: 'SIN-08',
    name: '"El mismo" as a pronoun',
    lang: 'es',
    level: 2,
    severity: 'low',
    patterns: {
      es: String.raw`(?<![\p{L}])(?:del|al|el|la|los|las|de la|de los) mism[oa]s?(?=\s*[.,;:)]|\s+(?:es|son|fue|ha|se|permite)(?![\p{L}]))`,
    },
    flags: 'giu',
    message: '"El mismo" used as a pronoun.',
    suggestion: 'Use the possessive or repeat the noun: "su uso".',
    source: { evidence: ['NORMA'], ref: 'RAE, Diccionario panhispánico de dudas, "mismo"', section: '13.2' },
    falsePositives: 'Identity statements ("El resultado fue el mismo.").',
    examples: [{ lang: 'es', fire: 'Armé el sistema y documenté el uso del mismo.', pass: 'Trabajé con el mismo equipo dos años.' }],
  },
  {
    kind: 'pattern',
    id: 'SIN-11',
    name: 'Chained possessives',
    lang: 'es',
    level: 2,
    severity: 'low',
    patterns: {
      es: String.raw`(?<![\p{L}])mis?\s+\p{L}+(?:\s+\p{L}+){0,2}\s*,\s*mis?\s+\p{L}+(?:\s+\p{L}+){0,2}\s*,?\s*(?:y|e)\s+mis?\s+\p{L}+`,
    },
    flags: 'giu',
    deviation: 'Each item may run to three words ("mi capacidad analítica, mi atención al detalle y mi orientación"), from the section 15 neutral letter.',
    message: 'Three possessives in a row, copied from English. Spanish drops the possessive when the owner is obvious.',
    suggestion: 'Replace the list with one fact.',
    source: { evidence: ['CONSENSO', 'NORMA'], ref: 'Section 1.1, item 10', section: '13.2' },
    examples: [{ lang: 'es', fire: 'Mi experiencia, mi compromiso y mi pasión.', pass: 'Mi experiencia y mi formación.' }],
  },
  {
    kind: 'pattern',
    id: 'REG-02',
    name: 'Workplace calques (Spanish)',
    lang: 'es',
    level: 2,
    severity: 'medium',
    patterns: {
      es: wordList([
        'aplic(?:ar|o|é|ando) (?:a|para) (?:un |el |la |este |esta )?(?:puesto|posición|búsqueda|vacante|rol)',
        'la posición de',
        'hac(?:er|e) sentido',
        'agregar valor',
      ]),
    },
    flags: 'giu',
    message: 'Calque from English job-search vocabulary.',
    suggestion: '"Postularme", "el puesto", "tener sentido".',
    source: { evidence: ['CONSENSO'], ref: 'Section 11, item 4', section: '13.2' },
    examples: [{ lang: 'es', fire: 'Quiero aplicar a la posición.', pass: 'Me postulo al puesto.' }],
  },
  {
    kind: 'pattern',
    id: 'CAR-03',
    name: 'Apologizing for a gap',
    lang: 'both',
    level: 2,
    severity: 'medium',
    patterns: {
      es: wordList(['lamentablemente', 'desafortunadamente', '(?:aunque|si bien) no (?:tengo|cuento)']),
      en: wordList(['unfortunately', "although I (?:don['’]t|do not) have", 'I lack']),
    },
    flags: 'giu',
    message: 'The gap is stated as an apology.',
    suggestion: 'State it plainly, with the plan: "No trabajé con dbt; ...".',
    source: { evidence: ['SÍNTESIS'], ref: 'Section 1.4, item 3', section: '13.2' },
    examples: [
      { lang: 'es', fire: 'Lamentablemente no tengo experiencia en dbt.', pass: 'No trabajé con dbt.' },
      { lang: 'en', fire: 'Unfortunately, I have not used Looker.', pass: "I haven't used Looker." },
    ],
  },
];

const englishGrammar: PatternRule[] = [
  {
    kind: 'pattern',
    id: 'SIN-EN-01',
    name: 'False friends',
    lang: 'en',
    level: 2,
    severity: 'medium',
    patterns: { en: wordList(['actually', 'eventually', 'assist(?:ed)? (?:to|at)', 'the career of', 'formation in', 'pretend(?:ed)? to']) },
    flags: 'giu',
    message: 'Possible false friend for a Spanish speaker ("actually" is not "actualmente").',
    suggestion: '"Currently", "attend", "a degree in", "training", "intend to".',
    source: { evidence: ['CONSENSO'], ref: 'Section 6.2', section: '6.2, 13.2' },
    falsePositives: '"actually" and "eventually" used in their English sense. A warning, not an error.',
    examples: [{ lang: 'en', fire: 'Actually I work at a retailer.', pass: 'Currently I work at a retailer.' }],
  },
  {
    kind: 'pattern',
    id: 'SIN-EN-03',
    name: 'Prepositions',
    lang: 'en',
    level: 2,
    severity: 'medium',
    patterns: {
      en: wordList([
        'depend(?:s|ing)? of',
        'interested on',
        'apply(?:ing)? to (?:the|this|a) (?:position|role|job)',
        'married with',
        'expert on doing',
        'graduated of',
      ]),
    },
    flags: 'giu',
    message: 'Preposition carried over from Spanish.',
    suggestion: '"depend on", "interested in", "apply for".',
    source: { evidence: ['CONSENSO'], ref: 'Section 6.2', section: '6.2, 13.2' },
    examples: [{ lang: 'en', fire: 'I am interested on the role.', pass: 'I am interested in the role.' }],
  },
  {
    kind: 'pattern',
    id: 'SIN-EN-04',
    name: 'Pluralized uncountables',
    lang: 'en',
    level: 2,
    severity: 'medium',
    patterns: { en: wordList(['informations', 'advices', 'knowledges', 'feedbacks', 'equipments', 'softwares', 'researches']) },
    flags: 'giu',
    message: 'Uncountable noun in the plural.',
    suggestion: '"information", "advice", "feedback".',
    source: { evidence: ['CONSENSO'], ref: 'Section 6.2', section: '6.2, 13.2' },
    examples: [{ lang: 'en', fire: 'I gathered informations from 30 branches.', pass: 'I gathered information from 30 branches.' }],
  },
  {
    kind: 'pattern',
    id: 'SIN-EN-06',
    name: 'Lowercase languages, days and months',
    lang: 'en',
    level: 2,
    severity: 'low',
    patterns: {
      en: wordList([
        'english', 'spanish', 'portuguese', 'french', 'german', 'italian',
        'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
        'january', 'february', 'april', 'june', 'july', 'september', 'october', 'november', 'december',
      ]),
    },
    flags: 'gu',
    message: 'English capitalizes languages, days and months.',
    suggestion: '"Spanish", "Monday", "October".',
    source: { evidence: ['CONSENSO'], ref: 'Section 6.2, SIN-EN-06', section: '6.2' },
    deviation: 'The report gives no regex for SIN-EN-06. "may", "march" and "august" are left out because they are common lowercase words.',
    examples: [{ lang: 'en', fire: 'I speak spanish and english.', pass: 'I speak Spanish and English.' }],
  },
];

const structural: StructuralRule[] = [
  {
    kind: 'structural',
    id: 'ESP-02',
    threshold: 'at least 1 anchor per 35 words',
    name: 'Anchor density',
    lang: 'both',
    level: 2,
    severity: 'high',
    message: 'Fewer than one anchor (number, tool, proper noun, year) per 35 words of prose.',
    suggestion: 'Add the facts from the CV that prove each claim.',
    source: { evidence: ['SÍNTESIS'], ref: 'Section 10, specificity dimension; Galdin and Silbert 2025', section: '10, 13.1' },
    deviation: 'Counted on prose sentences only, so salutation and signature lines are left out, as the report asks.',
    examples: [
      {
        lang: 'en',
        fire:
          'I am a motivated professional who enjoys solving problems with data and working with others. I believe that good ' +
          'analysis helps organizations make better choices, and I would like to bring that mindset to your company and grow with it.',
        pass: 'Since 2022 I have built Power BI dashboards on SQL Server for 30 branches, and in 2023 I automated the close in Python.',
      },
    ],
  },
  {
    kind: 'structural',
    id: 'EST-06',
    threshold: '0 in the first half',
    name: 'Rhetorical question as a hook',
    lang: 'both',
    level: 2,
    severity: 'medium',
    message: 'A question in the first half of the text reads as a hook.',
    suggestion: 'Answer it as a statement.',
    source: { evidence: ['CONSENSO'], ref: 'Section 4.2', section: '4.2, 13.2' },
    deviation:
      'The report counts every "?" and exempts a real question in the closing. Here a question is flagged only in the first half of the prose sentences.',
    examples: [
      {
        lang: 'en',
        fire: 'What makes a great analyst? I think it is curiosity. I built two dashboards. I wrote the SQL. I like the work.',
        pass: 'I built two dashboards. I wrote the SQL. I automated the close. I documented it. Could we talk on Thursday?',
      },
    ],
  },
  {
    kind: 'structural',
    id: 'EST-10',
    threshold: '35 words (en), 40 (es)',
    name: 'Long sentence',
    lang: 'both',
    level: 2,
    severity: 'medium',
    message: 'Sentence over 35 words (English) or 40 words (Spanish).',
    suggestion: 'Split it, and let a short sentence carry the main fact.',
    source: { evidence: ['MEDIDO'], ref: 'Anthropic, prompting guide for Claude Fable 5.1 (density)', section: '8.2, 13.1' },
    examples: [
      {
        lang: 'en',
        fire:
          'I built the dashboard that the managers of all thirty branches review every week and wrote the queries that feed it, ' +
          'including the one that matches stock against invoicing by branch, which took several weeks of work with the finance team to get right.',
        pass: 'I built the dashboard that thirty branch managers review every week.',
      },
    ],
  },
  {
    kind: 'structural',
    id: 'EST-11',
    threshold: 'CV at least 0.25 with 8+ sentences',
    name: 'Flat rhythm',
    lang: 'both',
    level: 2,
    severity: 'low',
    message: 'Sentence lengths barely vary (coefficient of variation under 0.25 across 8 or more sentences).',
    suggestion: 'Follow a long sentence with a short one that fixes the fact.',
    source: { evidence: ['SÍNTESIS'], ref: 'Section 8.2; no validated threshold for letters exists', section: '8.2, 13.1' },
    examples: [
      {
        lang: 'en',
        fire:
          'I work with data every day. I build reports for the sales team. I write queries in SQL Server. I keep the dashboards current. ' +
          'I check the numbers each week. I talk with the branch managers. I document the main processes. I want to keep doing this work.',
        pass:
          'I work with data. I build the weekly sales report for thirty branch managers, on SQL Server queries I wrote and maintain. ' +
          'It runs on Mondays. When a number looks wrong, I trace it back through the stock and invoicing tables until I find the cause. ' +
          'Usually it is a late upload. I document each fix. The managers read it. I want more of this.',
      },
    ],
  },
  {
    kind: 'structural',
    id: 'FMT-05',
    threshold: '2 per text',
    name: 'Revelation colons',
    lang: 'both',
    level: 2,
    severity: 'low',
    message: 'More than two colons that set up a reveal.',
    suggestion: 'Write the sentence straight.',
    source: { evidence: ['REPORTADO'], ref: WIKI, section: '4.4, 13.1' },
    deviation: 'Counts a colon inside a line followed by a lowercase word; colons that end a line (salutations, list intros) do not count.',
    examples: [
      {
        lang: 'en',
        fire: 'The goal: clarity. The method: data. The result: growth.',
        pass: 'The method was simple: I compared stock with invoicing.',
      },
    ],
  },
  {
    kind: 'structural',
    id: 'ORT-01',
    threshold: '0',
    name: 'Missing opening ¿ or ¡',
    lang: 'es',
    level: 2,
    severity: 'medium',
    message: 'Spanish opens questions and exclamations with ¿ and ¡.',
    suggestion: '"¿Querés verlo?"',
    source: { evidence: ['NORMA'], ref: 'RAE, Ortografía 2010', section: '13.2' },
    deviation: 'Counts per sentence instead of over the whole text, so one sentence cannot hide another one\'s missing sign.',
    examples: [{ lang: 'es', fire: 'Querés verlo?', pass: '¿Querés verlo?' }],
  },
  {
    kind: 'structural',
    id: 'ORT-04',
    threshold: '1 aside per text, all closed',
    name: 'Unclosed or extra inciso dash (Spanish)',
    lang: 'es',
    level: 2,
    severity: 'medium',
    message: 'A raya that opens an aside must close it, and a letter tolerates one aside between rayas.',
    suggestion: 'Close the aside, or use commas or parentheses.',
    source: { evidence: ['NORMA'], ref: 'RAE, Ortografía básica, la raya como signo delimitador', section: '3, 13.2' },
    deviation: 'Rayas glued between two letters are left to ORT-03 and not counted here.',
    examples: [
      {
        lang: 'es',
        fire: 'Trabajé con Ana —una gran analista, que me enseñó SQL.',
        pass: 'Trabajé con Ana —una gran analista— y aprendí SQL.',
      },
    ],
  },
  {
    kind: 'structural',
    id: 'ORT-05',
    threshold: '1 per text',
    name: 'Em dash density (English)',
    lang: 'en',
    level: 2,
    severity: 'medium',
    message: 'More than one em dash in the text.',
    suggestion: 'Use a comma or a period.',
    source: { evidence: ['REPORTADO'], ref: WIKI, section: '3, 13.2' },
    deviation: 'The report sets one per cover letter. The budget does not scale with length, so lint longer texts section by section.',
    examples: [
      {
        lang: 'en',
        fire: 'I wrote the queries — all of them — myself.',
        pass: 'I wrote the queries — all forty of them.',
      },
    ],
  },
  {
    kind: 'structural',
    id: 'REG-01',
    threshold: '0',
    name: 'Mixed voseo and tuteo',
    lang: 'es',
    level: 1,
    severity: 'high',
    message: 'The text mixes voseo and tuteo. One register, start to end.',
    suggestion: 'Pick one: "querés... podés" or "quieres... puedes".',
    source: { evidence: ['SÍNTESIS'], ref: 'Section 7.3', section: '7.3, 13.2' },
    deviation: '"mira" is dropped from the tuteo list because it is also the third person ("ella mira el tablero").',
    examples: [
      { lang: 'es', fire: 'Si querés, te muestro el tablero. Si puedes, avísame.', pass: 'Si querés, te muestro el tablero. Si podés, avisame.' },
    ],
  },
  {
    kind: 'structural',
    id: 'OFI-01',
    threshold: '1 per 12 words',
    name: 'Nominalization density',
    lang: 'both',
    level: 2,
    severity: 'low',
    message: 'More than one nominalization per 12 words.',
    suggestion: 'Turn the nouns back into verbs: "la optimización de" becomes "optimicé".',
    source: { evidence: ['SÍNTESIS'], ref: 'Section 5, OFI-01 (actions as verbs); section 8.2, suffix approximation', section: '5, 8.2' },
    deviation:
      'The report\'s OFI-01 asks for actions as verbs and names nominalization regexes plus the judge as its check. ' +
      'This is the regex half, with the section 8.2 threshold (more than 1 per 12 words). Applied from 24 words up.',
    examples: [
      {
        lang: 'es',
        fire:
          'La implementación de la optimización permitió la reducción de costos y la mejora de la coordinación entre áreas, con una ' +
          'consolidación de la información para la planificación.',
        pass: 'Optimicé el cierre mensual con Python y ahora tarda cuatro horas en lugar de tres días, así que los gerentes lo leen el lunes.',
      },
    ],
  },
  {
    kind: 'structural',
    id: 'MED-01',
    threshold: '2 per text',
    name: 'Adverbs in -mente',
    lang: 'es',
    level: 2,
    severity: 'low',
    message: 'More than two adverbs in -mente.',
    suggestion: 'Cut them or replace them with the fact.',
    source: { evidence: ['SÍNTESIS'], ref: 'Section 8.2', section: '8.2' },
    deviation:
      'The report gives this threshold in section 8.2 (Medición) without an id; MED-01 is this implementation\'s id. ' +
      'Spanish only: the report lists -ly as the English suffix but gives no threshold, and -ly also ends only, early, family, July and daily.',
    examples: [
      {
        lang: 'es',
        fire: 'Trabajé rápidamente, eficientemente y constantemente.',
        pass: 'Trabajé rápido y documenté cada paso.',
      },
    ],
  },
];

export const PATTERN_RULES: readonly PatternRule[] = [
  ...lexical,
  ...specificity,
  ...structure,
  ...rhetoric,
  ...format,
  ...spanishOrthography,
  ...spanishGrammar,
  ...englishGrammar,
];

export const STRUCTURAL_RULES: readonly StructuralRule[] = structural;

export const RULES: readonly Rule[] = [...PATTERN_RULES, ...STRUCTURAL_RULES];

export const TIER2_BUDGET = 2;

export function ruleById(id: string): Rule {
  const rule = RULES.find((r) => r.id === id);
  if (!rule) throw new Error(`Unknown rule ${id}`);
  return rule;
}

/** Voseo and tuteo verb forms for REG-01 (section 13.2, extended). */
export const VOSEO = wordList([
  'querés', 'podés', 'tenés', 'sabés', 'sos', 'hacés', 'decís', 'venís', 'pensás', 'necesitás',
  'contame', 'escribime', 'mirá', 'fijate', 'avisame', 'decime',
]);
export const TUTEO = wordList([
  'quieres', 'puedes', 'tienes', 'sabes', 'eres', 'haces', 'dices', 'vienes', 'piensas', 'necesitas',
  'cuéntame', 'escríbeme', 'fíjate', 'avísame', 'dime',
]);
