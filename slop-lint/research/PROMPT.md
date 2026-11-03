# Research prompt

This is the brief Federico Medinilla wrote to commission the deep-research report that the slop-lint rules come from. It was written for Claude Fable 5.1 with Research mode, in October 2026, and he curated the report that came back. The prompt is reproduced below in its original Spanish, with two cuts, each marked [...]: the app's name and a clause about its distribution plans. The usage notes that preceded it (which model setting to pick, where to save the result) are left out. The report itself is not in this repository; `src/rules.ts` keeps only the rules this linter implements, each with its evidence tag and source.

## Summary in English

The brief asks for a writing guide with three readers at once: a person editing a text, a language model that receives the guide in its system prompt, and a deterministic TypeScript linter that runs before a cover letter is shown. Its stated goal is good, specific and true writing, and it rules out tricks to evade AI detectors.

What it asks for:

- A taxonomy of the signs of generated text in Spanish and English, by layer (lexicon, sentence structure, rhetoric, format, content), with evidence of how each sign changed across model generations.
- The craft side: clarity, concision, information order, rhythm, register, drawn from normative and style sources in both languages (RAE and ASALE, Williams, Pinker, plain-language standards).
- Grammar and typography errors a careful writer fixes on sight, each with how to detect it, its regex if one exists, known false positives and the normative source.
- What recruiters say about cover letters in 2026, with marketing surveys labeled as such, and how to match a job posting against a CV without claiming anything the CV does not support.
- Measurement: readability formulas, sentence-length variation, lexical diversity, and the documented bias of AI detectors against second-language writers.
- Prompting practice for writing without slop, model-as-judge biases, and a 100-point rubric with hard disqualifiers.
- Evidence standards: every claim dated and tagged as measured, normative, reported, consensus or the researcher's own synthesis; no invented figures, studies or quotes.
- Deliverables: word lists by tier (banned, budgeted, context-dependent), a consolidated rule catalog with a fixed set of columns and ECMAScript regexes, three ready-to-use prompts, and three before/after cover letters for a fictional candidate.

---

# Encargo: la biblia para escribir como una persona que escribe bien, y para detectar cuándo un texto no lo hace (castellano e inglés), octubre de 2026

Sos el investigador principal de Federico Medinilla, desarrollador de aplicaciones con IA en Buenos Aires. Federico está construyendo [...], una app de escritorio que compara un CV contra hasta cincuenta ofertas laborales y, para las mejores, redacta con Claude Fable 5.1 una **carta de presentación** basada solo en lo que el CV prueba. La app se usa primero para él [...].

Tu informe es la **biblia** de esa escritura. Tiene tres lectores a la vez, y cada regla tiene que servirle a los tres:

1. **Una persona** que escribe o revisa un texto y necesita saber qué está mal, por qué y cómo se arregla.
2. **Un modelo de lenguaje** (Claude Fable 5.1) que recibe la biblia, o un extracto, en su prompt de sistema y tiene que escribir una carta que no suene a IA y que esté bien escrita.
3. **Un linter determinista** en TypeScript que revisa la carta antes de mostrarla: expresiones regulares, conteos, umbrales de densidad. Lo que una regex no puede ver, lo evalúa un segundo modelo con una rúbrica.

Para qué sirve y para qué no: no es una lista de "palabras que delatan a ChatGPT". El slop es un síntoma; la causa es escribir sin tener nada concreto que decir, o decirlo con moldes. La biblia cubre las dos mitades: **qué evitar** (el detector) y **cómo se escribe bien** (el oficio). Un texto sin una sola palabra prohibida puede seguir siendo vacío, y un texto bueno puede usar una raya bien puesta. Lo superficial no sirve.

Tampoco es un manual para engañar detectores de IA. El objetivo es que el texto sea bueno, específico y verdadero. Si lo es, la pregunta de quién lo escribió deja de importar. Las cartas que genera la app las firma una persona real y solo afirman lo que su CV respalda.

## El caso que tiene que cubrir sí o sí

- Una persona argentina se postula en Computrabajo, ZonaJobs, Bumeran o LinkedIn a un puesto que encontró hoy. La app le arma una carta de presentación en castellano (a veces en inglés, para puestos remotos o empresas de afuera) que va pegada en un campo de texto del portal o adjunta en PDF.
- La carta tiene que cruzar los requisitos concretos de la oferta con la evidencia concreta del CV (proyectos, cifras, herramientas, años), decir con honestidad qué falta cuando falta algo, y sonar a esa persona y no a una plantilla.
- Quien la lee es un reclutador o un gerente que ve decenas de cartas por semana, muchas escritas con IA, y las descarta en segundos.

## Datos que completa Federico (si quedan en blanco, usá el supuesto)

- Idiomas y variedades: [ ] (supuesto: castellano rioplatense y castellano neutro profesional; inglés internacional para puestos remotos)
- Registro de las cartas en castellano: [ ] (supuesto: lo decide la investigación, sección C; Federico no tiene posición tomada entre voseo, tuteo y usted)
- Textos propios adjuntos: [ ] (supuesto: ninguno; entonces la sección F explica cómo extraer la voz de una persona a partir de sus textos, sin aplicarlo)
- Qué conservar de la biblia anterior: [ ] (supuesto: el umbral de 80 sobre 100 para publicar y la división en niveles de palabras, si la investigación los respalda)

## Restricciones fijas

- Cada regla tiene que poder ejecutarse por al menos uno de los tres lectores. Si una regla solo se puede aplicar con criterio humano, decilo y dá la pregunta concreta que tiene que hacerse el revisor.
- Las reglas automáticas tienen que funcionar en JavaScript (expresiones regulares compatibles con ECMAScript, conteos sobre texto plano). Nada que exija un servicio pago o un modelo de NLP pesado sin dar la alternativa liviana.
- La biblia no promete que un texto "pase" un detector de IA, ni recomienda técnicas cuyo único fin sea evadirlos.
- Castellano rioplatense en el informe, con los términos técnicos en inglés donde son estándar. Los ejemplos en inglés van en inglés.

## Lo que ya existe (verificalo, no lo des por bueno)

Federico usaba una biblia anterior ("AI slop - detector") que hoy no tiene a mano. Por las auditorías que hizo con ella se sabe que incluía:

- Un **barrido mecánico**: rayas (con dos umbrales: más de tres por página, o más de una cada 150 palabras), "palabras de humo", paralelismo negativo (el molde "no es X, es Y" usado como muletilla), tríadas retóricas con un presupuesto de tricolones, honestidad autoproclamada ("nada se inventa", "te lo digo como es"), intensificadores, carraspeo (frases que preparan en vez de decir) y frases de LinkedIn.
- **Niveles de palabras**: un Tier-1 de palabras prohibidas, y otros niveles con más tolerancia.
- Una **rúbrica de 100 puntos** con umbral de publicación en 80, donde la especificidad valía 20 puntos, más un bloque de E-E-A-T (experiencia demostrable, autoría legible, pruebas).

Revisá cada una de esas reglas con evidencia: confirmala, ajustá el umbral o descartala, y decí por qué. En particular, los umbrales de la raya: en castellano la raya es un signo legítimo con usos normados (incisos, diálogo), y no es lo mismo que el em dash pegado a la palabra del inglés generado por modelos. Resolvé cómo se trata en cada idioma.

## Qué investigar

El orden de abajo es el pedido, no la estructura obligatoria. Si encontrás una mejor, usala y decilo en dos líneas.

### A. Taxonomía del AI slop: qué delata hoy un texto generado, en castellano y en inglés

Clasificá las señales por capa y, para cada una, dá ejemplo real, frecuencia o evidencia, y si cambió entre modelos y años (lo de 2023 no es lo de 2026):

1. **Léxico:** palabras y frases sobrerrepresentadas en texto de LLM frente a texto humano del mismo género. En inglés hay estudios de corpus sobre "vocabulario en exceso" (por ejemplo en resúmenes biomédicos y en revisiones de pares desde 2023); buscalos, verificá sus listas y su método. En castellano probablemente haya menos estudios: buscalos, y si no existen, construí la lista con criterio explícito y marcala como [SÍNTESIS]. Incluí calcos que los modelos traen del inglés al castellano.
2. **Estructura de oración y párrafo:** tricolones, paralelismo negativo, "no solo X sino también Y", rangos falsos ("desde X hasta Y"), preguntas retóricas como gancho, aperturas que preparan ("En el mundo actual", "Es importante destacar"), cierres que resumen lo que ya se dijo, longitud de oración y de párrafo demasiado uniforme (poca variación o *burstiness*), simetría de listas, variación elegante (sinónimos forzados para no repetir).
3. **Retórica y actitud:** inflación de importancia ("un hito", "un testimonio de"), lenguaje promocional, atribuciones vagas ("los expertos coinciden"), adulación, cobertura excesiva (*hedging*), entusiasmo impostado, honestidad autoproclamada, humildad de molde.
4. **Formato:** negritas de más, viñetas donde iba prosa, títulos con mayúscula en cada palabra (calco del inglés), emojis como viñetas, comillas inglesas en castellano, dos puntos antes de cada revelación.
5. **Contenido:** generalidades intercambiables, afirmaciones sin un dato, el "qué" sin el "cómo", ejemplos genéricos, ausencia de nombres propios, fechas y cifras.

Fuentes a verificar como punto de partida, sin darlas por buenas: la guía de Wikipedia sobre señales de escritura con IA (WikiProject AI Cleanup), los estudios de vocabulario en exceso en publicaciones científicas (2024 y 2025), la documentación de Anthropic sobre cómo pedirle estilo de escritura a Claude, y lo que hayan publicado editores, correctores y reclutadores con ejemplos concretos.

### B. El oficio: cómo escribe bien una persona que escribe bien

La mitad que la biblia anterior no tenía. Con fuentes de autoridad en cada idioma:

- **Castellano:** RAE y ASALE (Diccionario panhispánico de dudas, Nueva gramática, Ortografía de 2010, Libro de estilo de la lengua española de 2018), FundéuRAE, manuales de estilo de diarios de referencia, Daniel Cassany (*La cocina de la escritura*), José Martínez de Sousa, Álex Grijelmo, y el movimiento de lenguaje claro en Argentina y en el mundo hispano (verificá qué existe: redes, guías oficiales, normas).
- **Inglés:** Joseph Williams (*Style: Lessons in Clarity and Grace*), Steven Pinker (*The Sense of Style*), Orwell ("Politics and the English Language"), las guías de *plain language* y la norma ISO 24495-1:2023, con las críticas serias a los consejos clásicos (por ejemplo a Strunk & White).

Convertí eso en principios ejecutables: claridad (personajes como sujetos, acciones como verbos), concisión sin telegrama, concreción y especificidad, información conocida antes que la nueva, el énfasis al final de la oración, voz activa salvo motivo, nominalizaciones, ritmo (variar la longitud de las oraciones con intención), párrafos con una idea, conectores justos (ni de más ni de menos), precisión léxica, registro coherente. Para cada principio: qué dice, por qué funciona (con la explicación lingüística o cognitiva si la hay), un ejemplo malo y su reescritura, y cómo se verifica.

### C. Análisis sintáctico, gramatical y ortotipográfico

Lo que una persona bien letrada corrige sin pensar y un modelo a veces no:

- **Castellano:** concordancia, queísmo y dequeísmo, gerundio de posterioridad y otros gerundios incorrectos, leísmo, laísmo y loísmo, coma entre sujeto y verbo, signos de apertura, uso de la raya, el guion y las comillas (angulares, inglesas, simples), mayúsculas, tildes (incluidos *solo*, *guion*, demostrativos), números y cifras, abreviaturas y siglas, pasiva perifrástica de más ("fue realizado por"), "en base a", "a nivel de", posesivos innecesarios, "el mismo" como pronombre, anglicismos y calcos frecuentes en el mundo laboral ("aplicar a un puesto" por "postularse", "rol" por "papel", "hacer sentido", "remarcar", "expertise"). Distinguí lo que es error normativo de lo que es preferencia de estilo y de lo que es variante rioplatense legítima.
- **Inglés:** los errores típicos de hispanohablantes que escriben en inglés (falsos amigos, artículos, preposiciones, orden del adjetivo, *false friends* del mundo laboral) y las diferencias entre inglés americano y británico que importan en una carta.
- Para cada regla: cómo se detecta (regex, heurística, o juicio de un modelo), la regex si existe, sus falsos positivos conocidos y la fuente normativa.

### D. La carta de presentación en 2026: qué funciona y qué se descarta

- Qué dicen reclutadores y gerentes de selección, con datos cuando existan, sobre si se leen las cartas, cuánto tiempo, qué las hace descartables y cómo reconocen las escritas con IA. Separá encuestas con método de las de marketing (muchas de este tema son de empresas que venden CVs: etiquetalas).
- Estructura, largo y tono según el contexto: portales argentinos (verificá si Computrabajo, ZonaJobs, Bumeran y LinkedIn tienen campo de carta y con qué límite de caracteres), mail directo, puestos remotos para empresas de afuera, rubros formales y startups.
- **El registro en castellano rioplatense:** voseo, tuteo o usted en una carta de presentación en Argentina, según rubro y tipo de empresa. Buscá evidencia (guías de universidades, consultoras de RR. HH. argentinas, ejemplos publicados) y tomá posición.
- Cómo se cruza una oferta con un CV en prosa: elegir los dos o tres requisitos que más pesan, probar cada uno con un hecho del CV, decir qué falta sin pedir perdón ni disimularlo, y cerrar con un pedido concreto.
- Qué no puede afirmar nunca una carta que no esté en el CV, y cómo se escribe la falta de un requisito sin mentir ni autodestruirse.
- La versión en inglés: normas de Estados Unidos, Reino Unido y empresas remotas, y qué cambia respecto del castellano.

### E. Medición: qué se puede contar y cuánto vale

- Fórmulas de legibilidad en castellano (Fernández Huerta, Szigriszt-Pazos e INFLESZ, Gutiérrez de Polini, Crawford) y en inglés (Flesch, Flesch-Kincaid y otras): cómo se calculan, para qué sirven y sus límites. Decí cuáles vale la pena implementar en el linter y con qué rango objetivo para una carta.
- Variación de longitud de oración, diversidad léxica (TTR, MTLD), densidad de adjetivos y adverbios, densidad de nominalizaciones: qué evidencia hay de que distingan texto humano bueno de texto generado, y qué umbrales tienen sentido.
- **Detectores de IA** (GPTZero, Originality, Turnitin, Pangram y los que existan hoy): qué miden, precisión publicada y verificada por terceros, falsos positivos, el sesgo documentado contra quienes escriben en un idioma que no es el suyo, y por qué la app no los usa como criterio. Con fuentes.

### F. Prompt engineering para que un modelo escriba sin slop

Lo que funciona y lo que no, con evidencia o con la experiencia documentada de quienes lo midieron:

- Instrucciones positivas ("escribí así") frente a listas de prohibiciones ("no uses estas palabras"): cuándo una lista de prohibidas empeora el texto o hace aparecer sinónimos igual de malos.
- La especificidad sale de los insumos: cómo darle al modelo los hechos del CV y de la oferta para que no tenga que rellenar.
- Ejemplos de textos humanos (*few-shot*) y extracción de la voz de una persona a partir de sus textos: qué rasgos medir, cómo describirlos en un prompt, qué riesgo hay de caricatura.
- Generar, revisar y reescribir: un pase de redacción, el linter determinista, una revisión con rúbrica por un segundo modelo y una reescritura acotada. Cuántas vueltas valen la pena y cuándo se empeora el texto por sobrecorregirlo.
- Los sesgos de un modelo usado como juez (preferencia por textos largos, por su propio estilo) y cómo se controlan.
- Lo que Anthropic documenta sobre el estilo de Claude Fable 5.1 y cómo pedirle densidad, formato y tono.

### G. La rúbrica

Una rúbrica de 100 puntos, con umbral de publicación, compatible con la anterior si la evidencia lo permite. Dimensiones sugeridas, a confirmar: especificidad y verdad (cada afirmación con su hecho), oficio (claridad, ritmo, precisión), corrección (gramática y ortotipografía), ausencia de slop (léxico, estructura, retórica, formato), voz y registro, y adecuación a la oferta. Para cada dimensión: puntos, qué se mira, cómo se puntúa (con anclas: qué es un 0, un medio y un máximo), qué parte es automática y qué parte es juicio, y qué falla descalifica sin importar el puntaje total (por ejemplo, afirmar algo que no está en el CV).

### H. Lo que no se me ocurrió

Una parte explícita con lo que falta en esta lista y hay que mirar igual. Puntos de partida: cómo suenan las cartas traducidas del inglés, el slop propio del castellano generado (distinto del inglés), la diferencia entre sonar humano y sonar informal, cómo envejecen las listas de palabras cuando los modelos cambian, el slop en los asuntos de mail y en los mensajes cortos de LinkedIn, y los textos que suenan a IA aunque los haya escrito una persona.

## Estándares de evidencia

- Fechá cada afirmación relevante. El centro de gravedad es 2025 y 2026; lo anterior se marca y se justifica, en especial las listas de palabras, que cambian con cada generación de modelos.
- Fuentes primarias: obras normativas con su edición, estudios con método publicado, documentación oficial, ejemplos reales citados. Abrí las páginas; un fragmento de buscador no es fuente. Poné la URL al lado del dato.
- Etiquetá cada afirmación: [MEDIDO] dato con fuente primaria verificable; [NORMA] lo que dice una obra normativa o de referencia; [REPORTADO] prensa, blog, encuesta sin método claro o declaración; [CONSENSO] práctica profesional extendida entre editores y correctores; [SÍNTESIS] conclusión tuya. Las cinco valen; mezcladas sin distinguir, no.
- Cero cifras inventadas, cero estudios inventados, cero citas inventadas. "No hay dato público" es una respuesta válida y preferible a un número plausible.
- Buscá en inglés y en castellano. Cuando las fuentes se contradigan (pasa mucho entre gramáticos normativos y lingüistas descriptivos), mostralo y tomá posición.

## Qué no hacer

- No hagas una lista de consejos de escritura. Cada regla tiene que poder aplicarse: qué se busca, cómo se detecta, qué cuenta como falla, cómo se reescribe y cuándo no aplica.
- No condenes un recurso por estar en textos de IA si también es buena escritura humana usada con medida (la tríada, la raya, la pregunta). Decí dónde está la línea y cómo se mide.
- No escribas el informe con los vicios que describe. Se va a leer con su propia rúbrica.
- No termines cada sección con una advertencia ni con un resumen. Tomá posición y marcá la confianza con las etiquetas.

## Forma del entregable

Un informe en castellano, con secciones numeradas, tablas donde se comparan cosas y regex en bloques de código. **No hay tope de largo; sí hay tope de relleno.** Abrí con el veredicto en una página: las quince señales que más delatan un texto generado en castellano y las quince en inglés, las quince reglas de oficio que más mejoran un texto, y las cinco cosas que una carta de presentación nunca tiene que hacer. Después:

1. Las secciones A a H.
2. **Las listas de palabras y frases**, por idioma y por nivel: Tier 1 (prohibidas siempre en una carta), Tier 2 (toleradas con un umbral de densidad, que se dice), Tier 3 (dependen del contexto, con la regla que decide). Con la variante rioplatense marcada donde corresponda.
3. **El catálogo consolidado**, que es la pieza central del encargo: una fila por regla, con estas columnas fijas: ID (con prefijo por área: `LEX` léxico, `EST` estructura, `RET` retórica, `FMT` formato, `SIN` sintaxis y gramática, `ORT` ortotipografía, `OFI` oficio, `REG` registro y voz, `ESP` especificidad, `CAR` carta de presentación), nombre, idioma (ES, EN o ambos), qué es, ejemplo de la falla, reescritura, cómo se detecta (regex, heurística o juicio), regex si existe, umbral, severidad (descalifica, alta, media, baja), excepciones (cuándo no aplica), etiqueta de evidencia y fuente (URL). Repetí el catálogo al final como un bloque JSON (una lista de objetos con esas mismas claves en inglés) para importarlo al linter; si no entra completo, el Markdown alcanza.
4. **La rúbrica** de la sección G, lista para usar.
5. **Tres prompts listos para pegar**, escritos para Claude Fable 5.1 y que respeten lo que la investigación encontró en la sección F: el de redacción de la carta (recibe el perfil del CV, la oferta y el análisis de match), el de revisión con la rúbrica (devuelve puntaje por dimensión y las frases que fallan) y el de reescritura acotada (corrige solo lo marcado).
6. **Tres pares de cartas antes y después**, para un perfil ficticio y una oferta ficticia que digas: una en castellano rioplatense, una en castellano neutro y una en inglés. La versión "antes" es la carta típica de un modelo sin instrucciones; la "después" pasa la rúbrica. Puntuá las dos.
7. Preguntas abiertas: lo que solo Federico puede responder y cambiaría una regla.

Si algo del encargo es ambiguo, resolvelo como lo haría un colega cuidadoso, dejá escrita la suposición y seguí. Si una parte no se puede investigar, completá todo lo demás y decí exactamente qué faltó y por qué.
