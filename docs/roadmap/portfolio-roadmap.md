# Roadmap de remodelación del portfolio `applied-ai-toolkit`

Fecha: 2026-11-25 · Base: `main` en `6e1f465` · Autor del análisis: Claude Code, a pedido de Federico.

Documento de trabajo, no es documentación del repositorio. Parte de la tabla de decisiones de la sesión anterior y la baja a etapas ejecutables. Cada afirmación sobre el código lleva `ruta:línea`. Lo no verificado va marcado como **[SIN VERIFICAR]**. Las fuentes externas están numeradas `[n]` y listadas al final.

---

## 0. Diagnóstico en una pantalla

| Dato | Valor | Evidencia |
|---|---|---|
| Edad del repo | Primer commit 2026-11-16 (9 días), 111 commits | `git log --format=%ad \| tail -1` |
| Carpetas raíz | 22 librerías planas + `apps/` (9 apps) + `docs-site/` + `test/` | `ls` |
| Demos en Pages | 5 (Caja, Receipt, Replay Lab, Checklist, Rewriter) | `README.md:21-31` |
| Descripción del repo en GitHub | "eight small apps, four of them with live demos" → **desactualizada** (son 9 y 5) | `gh api repos/.../applied-ai-toolkit` |
| Releases | 0 | `gh api .../releases` |
| PRs abiertos | 1 (Dependabot, del día) | `gh api .../pulls` |
| Code scanning | No hay CodeQL ni upload de SARIF en CI | `grep -rn codeql .github` sin resultados |
| ADRs | No hay; las decisiones viven en las secciones "Design decisions" de cada README | `gateway/README.md:178`, `evals/README.md:228` |
| Agrupación por dominio | **Ya existe** en el README (4 grupos) y en el sidebar de docs-site | `README.md:53-87`, `docs-site/scripts/site.ts:21-27` |
| Lo que ve primero un reclutador | Bio en prosa más una sección "Where to start", sin tabla por rol, sin diagrama y sin badges | `README.md:1-20` |

**Conclusión:** el problema no es de profundidad técnica (sobra) ni de organización de carpetas. Es de **primera impresión y de evidencia visible en la interfaz de GitHub**: Security tab vacía, cero releases, perfil sin README, una descripción que contradice al README y ningún diagrama. Las fuentes sobre cómo se revisan los repos coinciden en que la primera pasada dura menos de 30 segundos y la decide el README [11][12]. El 61 % de los avisos de AI Engineer piden evals [13][14]; el repo ya las tiene, pero no se ven en la primera pantalla.

---

## 1. Restricciones duras (leer antes de tocar nada)

### 1.1 Otra sesión de Claude trabaja en el reescritor y en slop-lint

La rama `claude/eloquent-ride-jfq4ec` tiene trabajo sin mergear en `prose-rewriter/` (12 archivos: `diagnose.ts`, `shape.ts`, `prompt.ts`, etc.). `docs-site/scripts/site.ts:58-60` deja `prose-rewriter` y `style-refs` fuera del sitio "mientras se construyen (fases F0 a F6)" y les reserva un grupo en el sidebar para F7.

**Zona prohibida para esta remodelación hasta que esa sesión cierre:**

| Ruta | Motivo |
|---|---|
| `prose-rewriter/**`, `style-refs/**`, `slop-lint/**` | Los está editando la otra sesión |
| `apps/rewriter/**`, `apps/writer/**` | Consumen esas librerías |
| `docs-site/scripts/site.ts` (`NOT_DOCUMENTED`, grupos) | La F7 de la otra sesión lo toca |
| `package.json` (script `lint:docs`, workspaces) | Archivo compartido: según tu regla, solo lo toca una tarea dedicada o el integrador |

**Acoplamiento indirecto que hay que vigilar:** `npm run lint:docs` corre **slop-lint** sobre todos los READMEs, `SECURITY.md`, `docs-site/pages/*.md` y otros (`package.json:21`), y CI lo ejecuta en cada push (`.github/workflows/ci.yml:107-108`, más la action en `:156-163`). Todo texto nuevo que escribamos (README raíz, SECURITY, páginas de docs-site) **tiene que pasar el slop-lint vigente**. Si la otra sesión cambia reglas, un doc que hoy pasa puede fallar mañana. Mitigación:
1. Antes de cada PR de docs, rebase sobre `main` y `npm run lint:docs` local.
2. Mergear primero lo de la otra sesión cuando las dos tengan PR abierto, y después rebasar las de docs.
3. Las piezas que mencionen al reescritor (tour, caso Antes/Después) quedan para la **Etapa 6**, cuando el reescritor esté estable.

### 1.2 La política de workflows bloquea permisos de escritura

`agent-playbook/test/workflow-secrets.test.ts:22-25` recorre **cada** `.yml` de `.github/workflows/` y falla si alguno tiene un secreto o un permiso de escritura fuera de su política. `agent-playbook/src/workflow-secrets.ts:67` declara `NEVER_WRITE`, que incluye `security-events`, `contents` y `checks`. Un permiso de esa lista solo se habilita con `allowRepositoryWrite` en una política propia (`:56-61`).

Consecuencias concretas:
- **CodeQL en advanced setup** (workflow propio) necesita `security-events: write` → rompe el test. **Default setup** se activa desde Settings, sin archivo en el repo [2][3] → no toca la política. Recomendación: default setup.
- **Subir los SARIF** que ya generan slop-lint, csp-build-guard e import-fences (`ci.yml:196-210` hoy solo los valida) también requiere `security-events: write`. Es una decisión de seguridad real: se toma con una política `SARIF_UPLOAD_POLICY` nueva, un test y un ADR, no a escondidas.
- **OpenSSF Scorecard** con badge publicado requiere `id-token: write` [6], que sí es habilitable por `allowWrite` (como en `PAGES_DEPLOY_POLICY`, `workflow-secrets.ts:43-47`). Sin upload de SARIF no hace falta `security-events`.
- **GitHub Releases desde Changesets** (`createGithubReleases`) necesitaría `contents: write` en el job de publish, que hoy tiene solo `id-token` por diseño (`release.yml:9-12`, `workflow-secrets.ts:56-61`). Además el release está apagado hasta que exista la variable `NPM_RELEASE` (`release.yml:3-5`, `:40`). Ver la Etapa 5.

Cada cambio de política es un **ADR** (Etapa 4). Esa es justamente la clase de criterio que el portfolio quiere mostrar.

### 1.3 La estructura de carpetas es un contrato público

- `import-fences/repo.config.ts:17-26`: cada carpeta de primer nivel es una librería autocontenida que "se puede copiar sola fuera del repositorio". Es una propiedad de diseño.
- Las tres GitHub Actions se publican como `Fedemedinilla/applied-ai-toolkit/<carpeta>@<SHA>` (`slop-lint/README.md:137`, `csp-build-guard/README.md:155`, `import-fences/README.md:159`). GitHub resuelve una action de un subdirectorio como `owner/repo/path@ref` [9]. Moverlas a `security-hardening/csp-build-guard` cambia esa ruta pública.
- `git log --follow` sigue **un solo archivo**: no sigue directorios enteros [10]. Una mudanza masiva corta la lectura de historia por carpeta (`git log -- gateway/`) en la interfaz y en la CLI.

→ **Decisión: no se reorganiza en 4 dominios.** La escaneabilidad se logra con la Etapa 2.

---

## 2. Vista general de etapas

| Etapa | Objetivo | Esfuerzo | Archivos (aprox.) | Depende de | Toca zona prohibida |
|---|---|---|---|---|---|
| **E1** Higiene y señales de GitHub | Que la interfaz de GitHub no contradiga al repo | 1 sesión corta, mucha acción manual tuya | 0–2 | — | No |
| **E2** Primera pantalla del README | Que un reclutador entienda el repo en 60 s | 1 sesión | 2–4 | E1 | `README.md` (compartido: tarea dedicada) |
| **E3** Modelo de amenazas | La mejor carta de "seguridad" del perfil | 1 sesión | 1–2 | — | No |
| **E4** Evidencia en CI + ADRs | Madurez visible en Actions y criterio explícito | 1–2 sesiones | 6–10 | E3 (ADR de la política) | No |
| **E5** Releases y perfil | Señal de proyecto vivo y portada personal | 1 sesión | 2–4 + repo de perfil | E2 | No |
| **E6** Tour y caso Antes/Después | Recorrido guiado con el reescritor | 1 sesión | 3–5 | **Cierre de la otra sesión** | Sí, por eso va al final |
| **E7** Profundidad: RAG con citas verificables | La pieza técnica más pedida que hoy falta | 3–4 sesiones | 20+ (pedir OK) | E4 | No |

Cada etapa es una rama `claude/<tema>` y un PR. El merge lo hacés vos. Ninguna etapa toca más de 20 archivos, salvo E7, que se propone aparte.

---

## E1. Higiene y señales de GitHub

**Objetivo:** que todo lo que GitHub muestra *alrededor* del código sea coherente y tenga señales de mantenimiento.

| # | Acción | Quién | Cómo / detalle técnico | Por qué (fuente) |
|---|---|---|---|---|
| 1.1 | Corregir la descripción del repo | Vos (Settings → About) | Texto propuesto: *"Production patterns for LLM apps: a Claude API gateway with hard spending caps, evals with a statistical CI gate and a red-team runner, security guards for LLM output and websites. Nine apps, five live demos. TypeScript, Python, PHP; every test runs offline."* | Hoy dice 8 apps / 4 demos y el README dice 9 / 5 (`README.md:21`). Una inconsistencia en la primera línea resta credibilidad [12] |
| 1.2 | Topics | Vos | Agregar `python`, `php`, `github-actions`, `sarif`, `code-quality`, `rag` (este último recién en E7). Sacar `pwa` si no es central. Máximo 20 topics | Los topics alimentan la búsqueda de GitHub |
| 1.3 | Mergear o cerrar [Fedemedinilla/applied-ai-toolkit#35](https://github.com/Fedemedinilla/applied-ai-toolkit/pull/35) | Vos | Es el grupo minor/patch de Dependabot. Revisalo como dice `MAINTENANCE.md:29-46` | Un PR de bot abierto parece abandono |
| 1.4 | Activar **CodeQL default setup** | Vos (Settings → Code security → Code scanning → Default) | Lenguajes detectables acá: `javascript-typescript`, `python` y `actions` [3][4]. **PHP no lo cubre CodeQL**: `wp-hardening` queda cubierto por PHPUnit (`ci.yml:215-245`) y hay que decirlo en SECURITY.md | Gratis en repos públicos. No necesita workflow, así que no choca con `NEVER_WRITE` (§1.2) [2] |
| 1.5 | Confirmar **private vulnerability reporting** activo | Vos (Settings → Security) | `SECURITY.md:36` ya enlaza al formulario y avisa que solo funciona si está activado | Si el link no muestra formulario, la política queda rota |
| 1.6 | **Ruleset** sobre `main` | Vos (Settings → Rules) | Exigir PR y que pasen los checks `Check and test`, `Docs site`, `Composite actions` y `wp-hardening (PHP)`; bloquear force push | Lo mide el check *Branch-Protection* de Scorecard. Los rulesets nuevos se leen con el token por defecto [6] |
| 1.7 | Imagen de **social preview** | Vos (Settings → Social preview), yo genero el PNG | 1280×640, fondo sólido, título y 3 frases con lo que demuestra el repo [15]. Se genera con Playwright desde un HTML local | Es lo que se ve cuando pegás el link en LinkedIn o en un mail de postulación |

**Verificación:** `gh api repos/Fedemedinilla/applied-ai-toolkit --jq '{description,topics}'` y la pestaña Security con "Code scanning: enabled".

---

## E2. Primera pantalla del README raíz

**Objetivo:** que en una pantalla (unas 40 líneas renderizadas) se lea qué es, para qué rol sirve cada parte, cómo se ve funcionando y cómo se verifica. Sin perder el detalle de abajo.

**Archivos:** `README.md` (compartido → PR dedicado), quizás `MAINTENANCE.md` (adonde se mudan "Dependencies" y "Fixtures"), `docs-site/pages/index.md`.

### 2.1 Estructura nueva del README (de arriba hacia abajo)

1. **Título y dos líneas de propuesta**, en inglés como el resto del repo. Primero lo que hace el código, después quién sos:
   > Production patterns for putting an LLM into real applications: hard spending caps, measured prompt changes, model output treated as untrusted, and every test offline.
2. **Badges reales**, nunca estáticas como la "CI offline verified" que proponía Gemini:
   - `ci.yml`: `https://github.com/Fedemedinilla/applied-ai-toolkit/actions/workflows/ci.yml/badge.svg?branch=main`
   - `pages.yml` (mismo patrón), licencia MIT, y **OpenSSF Scorecard** cuando exista (E4) [6].
3. **Tabla "Start here by role"** (3–4 filas). Columnas: rol | qué abrir | qué prueba | test que lo respalda. Ejemplo para la fila de AI/LLM: `gateway/` (reserva el peor costo antes de llamar, `gateway/README.md:182`) · `evals/` (gate con intervalos de Wilson y Newcombe, `evals/README.md:181-216`) · red-team con historia firmada por HMAC (`evals/README.md:293`).
4. **Diagrama Mermaid** de cómo se componen las piezas. GitHub lo renderiza nativo en Markdown [16]:
   ```mermaid
   flowchart LR
     App[apps/*] -->|public entry only| GW[gateway: caps + ledger]
     GW --> API[(Claude API)]
     App --> SM[safe-markdown]
     SM --> Page[page]
     EV[evals: runner, gate, red-team] -.measures.-> App
     IF[import-fences] -.enforces boundaries.-> App
     CSP[csp-build-guard] -.checks builds.-> App
   ```
   El diagrama tiene que salir de `import-fences/repo.config.ts` (`LIBRARY_USES`, `APP_USES`), no inventarse. Opcional: un test que verifique que cada flecha del diagrama existe en la config, al estilo del sync que ya hace docs-site.
5. **Demos con un caso borde cada una**: la tabla actual (`README.md:21-31`) ya lo hace bien; sube de posición.
6. **Verificación en un comando**: `npm ci && npm test`, más `npm run check`, `npm run test:python`, `npm run test:php` (`package.json:13-20`), con el conteo real de tests en un CI reciente.
7. **Capturas o GIF** de 2 o 3 demos (Caja con la pregunta por monto ambiguo, Replay Lab con hash roto). Las saco con Playwright a `deviceScaleFactor: 2`, las optimizo (<300 KB cada una) y van en `docs/media/`.
8. Lo que hoy ocupa media pantalla (Packages, Dependencies, Fixtures, `README.md:157-178`) **se queda, pero más abajo**. "Dependencies" y "Fixtures" pueden pasar a `MAINTENANCE.md` con un link.

### 2.2 Qué NO hacer
- No duplicar la agrupación: ya está en `README.md:53-87` y el sidebar la lee de `site.ts:21`. La tabla por rol es una vista arriba que **enlaza** a esos grupos.
- No exagerar: nada de "production-ready" sin decir en qué producción. El README actual es honesto ("extracted from a production app I am building", `gateway/README.md:3`) y eso hay que mantenerlo.

**Verificación:** `npm run lint:docs` (slop-lint sobre el README nuevo), `npm run build:docs` (el link check de docs-site) y una captura del README renderizado.

---

## E3. Modelo de amenazas en `SECURITY.md`

**Objetivo:** convertir `SECURITY.md` (hoy solo política de reporte, 51 líneas, `SECURITY.md:1-51`) en la prueba más fuerte de criterio en seguridad. Cada amenaza va con el módulo que la mitiga **y el test que lo demuestra**.

### 3.1 Marco de referencia
Mapear contra **OWASP Top 10 for LLM Applications 2025** [1]. Existe una edición **2026**, publicada en agosto de 2026, que mantiene las 10 áreas con algunos renombres; prompt injection sigue #1 y excessive agency subió al #3 [17][18]. El ranking exacto 2026 queda **[SIN VERIFICAR]**: antes de escribir hay que leer el PDF oficial y usar la numeración 2026 como columna principal y la 2025 como referencia.

### 3.2 Tabla a construir (borrador; cada fila se verifica contra el código antes de publicar)

| Amenaza | OWASP LLM (2025) | Mitigación en el repo | Evidencia a citar |
|---|---|---|---|
| Prompt injection directa e indirecta | LLM01 | Red-team runner con historia firmada por HMAC; los intentos con historia forjada se rechazan sin llamar al modelo | `evals/README.md:293`, `evals/scripts/redteam.ts` |
| El modelo actúa por su cuenta | LLM06 Excessive Agency | "The model proposes, code decides": `decide()` valida cada reserva contra los datos | `grounded-assistant/README.md:44`, `:51` |
| Salida del modelo insertada en una página | LLM05 Improper Output Handling | `safe-markdown` con suite XSS y property tests | `safe-markdown/test/xss.test.ts`, `properties.test.ts` |
| Consumo y costo sin límite | LLM10 Unbounded Consumption | Reserva del peor costo antes de la llamada, ledger idempotente, deadline propio | `gateway/README.md:182`, `:202`, `:226` |
| Fuga del system prompt | LLM07 | El red-team marca una regla filtrada | `evals/README.md:293` ("a leaked rule is flagged") |
| Cadena de suministro | LLM03 Supply Chain | Actions fijadas por SHA, Dependabot con cooldown de 7 días, versiones exactas, npm trusted publishing con provenance | `ci.yml:11`, `.github/dependabot.yml:1-15`, `release.yml:8-12` [7] |
| Secretos en CI | LLM02 / plataforma | Test que impide secretos y permisos de escritura en workflows | `agent-playbook/src/workflow-secrets.ts:67`, `agent-playbook/test/workflow-secrets.test.ts:22` |
| XSS y CSP en las apps | Web (OWASP Top 10) | `csp-build-guard` sobre cada build | `ci.yml:80-81`, `:177` |
| Auth en Supabase | Web | `supabase-auth-hardening` con Postgres real (PGlite) | `README.md:172` [SIN VERIFICAR: archivo de test] |
| WordPress | Web | `wp-hardening` + PHPUnit | `ci.yml:215-245` |
| Data poisoning, embeddings | LLM04, LLM08 | **Fuera de alcance hoy**; se cubre en E7 si se hace el RAG | — |
| Misinformation | LLM09 | Parcial: `grounded-assistant` toma el precio y la duración de los datos, no del modelo. E7 suma citas verificadas | `grounded-assistant/README.md:51` |

### 3.3 Secciones nuevas de `SECURITY.md`
1. **Threat model** (la tabla de arriba).
2. **Trust boundaries**: qué datos se consideran no confiables (todo lo que viene del modelo, del visitante y de archivos importados) y dónde se valida cada uno.
3. **Known gaps**: qué *no* cubre (LLM04/08, PHP sin CodeQL, demos en Pages sin headers CSP, `README.md:33`). Decir lo que falta da más credibilidad que esconderlo.
4. Mantener la política de reporte actual tal cual (`SECURITY.md:34-51`).

**Antes del PR:** pasarle el diff al subagente `revisor-seguridad` y al `verificador-de-hechos` (cada fila cita un archivo real).

---

## E4. Evidencia en CI y ADRs

### 4.1 Job summaries (`$GITHUB_STEP_SUMMARY`)

GitHub muestra en la página del run el Markdown que cada step escribe en ese archivo [5].

| Step | Qué hace hoy | Cambio |
|---|---|---|
| Vitest (`ci.yml:54-55`) | Vitest ≥1.3 agrega el reporter `github-actions` solo cuando `GITHUB_ACTIONS=true`, y las versiones recientes escriben un job summary con conteos y flaky tests [19]. El repo usa Vitest 5.1.0 (`README.md:174`) y no configura `reporters` (`vitest.config.ts`) | **[SIN VERIFICAR]**: puede que ya haya un summary. Primero mirar un run reciente; si no está, configurar `reporters: ['default', 'github-actions']` |
| Eval gate | `gate.ts` ya acepta `--markdown --summary "$GITHUB_STEP_SUMMARY"` (`evals/README.md:213`, `evals/scripts/gate.ts:15`), pero CI no lo corre | Step nuevo: `node evals/scripts/gate.ts evals/example/tickets-baseline.json evals/example/tickets-candidate.json --markdown --summary "$GITHUB_STEP_SUMMARY"` y `node evals/scripts/demo-offline.ts` (`evals/scripts/demo-offline.ts:1-9`). Hay que aclarar en el summary que son **fixtures que miden la plomería, no un modelo**, como ya dice el script |
| import-fences, csp-build-guard, slop-lint | Generan SARIF y CI los valida (`ci.yml:196-210`) | Paso con `node` que lea los tres SARIF y escriba una tabla (herramienta · reglas · hallazgos). No hace falta permiso nuevo |
| Mutation (`quality.yml`, semanal) | Stryker por target | Escribir el mutation score de cada target al summary. Es la métrica más rara de ver en un portfolio y conviene que se vea |
| PHP / Python | PHPUnit / unittest | Una línea con el conteo |

**Regla:** todos los steps de summary van con `if: always()`, para que aparezcan también cuando algo falla [5].

**Restricción:** `workflow-secrets.test.ts` revisa cada workflow. Estos cambios no agregan permisos, así que pasan con la política por defecto (`workflow-secrets.ts:40`). Verificar con `npx vitest run agent-playbook/test/workflow-secrets.test.ts`.

### 4.2 OpenSSF Scorecard (opcional, recomendado)
- Workflow `scorecard.yml` con `ossf/scorecard-action` fijada por SHA, `publish_results: true`, permisos de primer nivel en lectura e `id-token: write` solo en el job [6].
- **Sin** upload de SARIF (eso sería `security-events: write`, ver §1.2).
- Política nueva `SCORECARD_POLICY = { allowWrite: ['id-token'] }` en `workflow-secrets.ts` y su test, igual que `PAGES_DEPLOY_POLICY`.
- El repo ya cumple varios checks (Pinned-Dependencies, Token-Permissions, Dependency-Update-Tool, SAST cuando esté CodeQL). El badge en el README es una prueba externa y difícil de falsear.

### 4.3 ADRs en `docs/adr/`

Formato **MADR** simplificado [8]: Status, Date, Context, Decision, Considered options, Consequences. Se eligió sobre Nygard [20] porque MADR obliga a listar las opciones descartadas, que es lo que se quiere mostrar. Cada ADR **enlaza** a la sección "Design decisions" del README del módulo en vez de copiarla.

| ADR | Decisión | Fuente en el repo |
|---|---|---|
| 0001 | Registrar decisiones con MADR | — |
| 0002 | El gateway es la única salida a la API de Claude, con reserva del peor caso | `gateway/README.md:3`, `:182-204`; fence en `import-fences/repo.config.ts` |
| 0003 | Todos los tests offline y deterministas: fakes con guion, PGlite, sin key | `README.md:14`, `evals/scripts/demo-offline.ts:1-9` |
| 0004 | Carpetas planas autocontenidas cruzadas solo por su entrada pública (por qué **no** se reorganiza en dominios) | `import-fences/repo.config.ts:17-26` y §1.3 de este doc |
| 0005 | Workflows sin secretos ni escritura, salvo por política explícita | `agent-playbook/src/workflow-secrets.ts:40-67` |
| 0006 | El eval gate usa Newcombe/Wilson y "inconclusive" no cuenta como pass | `evals/README.md:181-211` |
| 0007 | CodeQL en default setup, y cuándo pasar a advanced | §1.2 |

Lo que **no** va como ADR: la decisión de prosa (ADR-002 de Gemini). Pertenece a `prose-rewriter`, que lo maneja la otra sesión, y no cruza módulos.

**Archivos compartidos:** para que slop-lint revise los ADRs hay que sumar `docs/adr/*.md` al script `lint:docs` (`package.json:21`). Ese cambio va en un commit aparte del PR, avisando que toca un archivo compartido.

---

## E5. Releases y perfil de GitHub

### 5.1 Releases
Hoy hay 0. El pipeline de Changesets con trusted publishing está listo pero apagado (`release.yml:3-5`). Tres opciones:

| Opción | Qué implica | Recomendación |
|---|---|---|
| A. Release manual de repo `v0.1.0` | Tag más release en la interfaz con notas escritas a mano: módulos, demos, cómo verificar | **Sí, ahora.** Sin permisos nuevos |
| B. Publicar en npm (`NPM_RELEASE=enabled`) | Configurar el trusted publisher en npmjs.com; el job de publish emite provenance por OIDC [7] | Sí, para `slop-lint` e `import-fences` (los más reutilizables), cuando la otra sesión cierre slop-lint. Un paquete en npm con provenance verificable vale mucho como evidencia |
| C. `createGithubReleases` en el action | Requiere `contents: write` en el job de publish → cambio de `RELEASE_POLICY` más un ADR | Más adelante, si B funciona |

### 5.2 README de perfil (`Fedemedinilla/Fedemedinilla`)
- Repo público con el mismo nombre que el usuario y `README.md` en la raíz [21]. No tengo acceso a ese repo desde esta sesión (403): te dejo el texto para pegar.
- Contenido: 3 líneas (qué construís, dónde, para quién), los links (sitio, demos, LinkedIn) y una tabla de 4 piezas con link directo. **Nada de** contadores de visitas, gráficos de lenguajes ni rachas.
- Repos fijados: `applied-ai-toolkit` en el #1 y `new-website-medinilla` solo si tiene README y CI. [SIN VERIFICAR: estado de ese repo]

### 5.3 Links por rol para las postulaciones (fuera del repo)
Una nota personal con el link profundo por rol, sacado de la tabla de E2: AI → `evals/CASE-STUDY.md`; Security → `SECURITY.md#threat-model`; Backend → `idempotent-orders/`; Full-stack → demos.

---

## E6. Tour guiado y caso Antes/Después (después de la otra sesión)

**Precondición:** la rama de la otra sesión está mergeada y `prose-rewriter` salió de `NOT_DOCUMENTED` (`docs-site/scripts/site.ts:60`).

- Portada de docs-site (`docs-site/pages/index.md`): extender "Where to start" (`README.md:16-19`) en lugar de crear otra sección: el diagrama de E2 más un caso borde por demo.
- Caso Antes/Después del reescritor: **lo escribe o aprueba la otra sesión**, porque conoce las métricas (`prose-rewriter/README.md:133` "Measured"). Desde acá solo se enlaza.
- Gemini proponía "Tour en 3 minutos". Se descarta como sección nueva porque duplica "Where to start".

---

## E7. Profundidad técnica: respuestas con citas verificables y abstención

**Por qué:** es lo que más falta respecto del mercado. `grounded-assistant` no es RAG: es validación de reservas (`grounded-assistant/README.md:44-57`). Los avisos piden RAG con evals [13][14], y la abstención ante preguntas sin respuesta es un área de investigación activa [22].

**Propuesta: librería nueva `cited-answers/`** (nombre a definir). Toca más de 20 archivos, así que necesita tu OK aparte.

| Pieza | Diseño | Justificación |
|---|---|---|
| Recuperación | Léxica BM25 en memoria sobre un corpus ficticio (siguiendo la política de fixtures, `README.md:176`) | Determinista y offline. Comparar con una búsqueda simple y publicar las métricas |
| Generación con citas | **Citations API de Claude**: bloques `document` con `citations: {enabled: true}`; cada cita trae `cited_text` y la ubicación en caracteres [23] | Nativo y sin parsear texto libre |
| **Restricción técnica** | Citations es **incompatible con `output_config.format`** (devuelve 400) [23]. El gateway arma `output_config.format` cuando hay schema (`gateway/src/gateway.ts:464`) | Hace falta un modo nuevo en el gateway (texto con citas, sin schema). Es otro ADR y un cambio de API pública, con su changeset |
| Verificación en código | Para cada cita: `document.slice(start, end) === cited_text`, más la regla "toda oración con una afirmación tiene al menos una cita". Si falla → abstención | La precisión de las citas se chequea de forma **determinista** y no depende de un juez. La literatura avisa que la fidelidad sola no prueba que las citas sean correctas [22] |
| Abstención | Si la recuperación no supera un umbral o la verificación falla, respuesta fija "no tengo evidencia" con código | El modelo propone y el código decide, la misma filosofía que el resto del repo |
| Evals | Casos respondibles y no respondibles (categorías de UAEval4RAG [22]), métricas: tasa de abstención correcta, falsa abstención, precisión de citas. Gate con el `gate.ts` existente | Reusa la infraestructura que ya existe |
| Demo | App estática en Pages con respuestas grabadas, como Rewriter (`README.md:31`) | Sin key y sin servidor |

**El resto de C (tool-calling + retry con feedback + fallback)** no va como módulo aparte: el gateway ya valida la salida estructurada con zod y deja los reintentos al caller (`gateway/README.md:3`, `:226`). Si se suma algo, es un ejemplo de loop de reintento con feedback del error *encima* del gateway dentro de esta misma librería.

---

## 8. Lo que se descarta y por qué

| Propuesta de Gemini | Decisión | Motivo |
|---|---|---|
| Reorganizar en `ai-core/`, `security-hardening/`… | ❌ | §1.3: rompe las rutas públicas de las Actions, la portabilidad por carpeta y la historia por directorio [9][10]. La agrupación ya existe en el README y en docs-site |
| Consolidar `content-pipeline/` | ❌ | `prose-rewriter` ya compone slop-lint, style-refs, evals y gateway (`README.md:14`), y es zona de la otra sesión |
| Mini-READMEs de 30–45 líneas | ❌ | Recortaría las decisiones de diseño, que son lo más valioso. En su lugar: un TL;DR de 3 líneas arriba de cada README estrella (en E2, sin tocar los de la zona prohibida) |
| Badge "CI offline verified" | ❌ | Es estática, o sea falsa. Se usan las badges reales del workflow |
| "749+ commits" | ❌ | Dato inventado: son 111 |
| ADR de prosa | ❌ como ADR | Pertenece al README del reescritor |
| `resilient-agent` como módulo | ❌ | Lo cubre el gateway; ver E7 |
| Dependabot agrupado | ✅ ya existe | `.github/dependabot.yml` |

---

## 9. Riesgo de "repo de 9 días"

El repo tiene 9 días y 111 commits. Un reviewer puede leer eso como un volcado de último momento. Lo que lo contrarresta (sin fabricar nada):
- Cadencia sostenida: PRs chicos y frecuentes, como los que ya hacés.
- Releases con fecha (E5) que muestren evolución.
- El `README.md:98` "Client work" y los links a federicomedinilla.com y kyndredai.com, que demuestran que el código sale de trabajo real anterior. Conviene que eso se lea en la primera pantalla (E2).

---

## 10. Orden de ejecución y checklist

1. **Hoy, manual (vos):** 1.1, 1.2, 1.3, 1.4, 1.5, 1.6.
2. **PR `claude/security-threat-model`** (E3): solo `SECURITY.md`. No choca con nadie.
3. **PR `claude/ci-evidence`** (E4.1 + E4.2): workflows, la política nueva y su test.
4. **PR `claude/adr`** (E4.3): `docs/adr/*` más el cambio en `lint:docs` en un commit aparte.
5. **PR `claude/readme-first-screen`** (E2): README raíz, capturas y social preview. Rebasar sobre `main` justo antes, por slop-lint.
6. **Release `v0.1.0`** manual y README de perfil (E5).
7. **Cuando la otra sesión cierre:** E6, y después E5-B (npm).
8. **Propuesta aparte con tu OK:** E7.

Verificación por PR (lo que define "listo"): `npm run check`, `npm test` (con el conteo), `npm run lint:docs`, `npm run build:docs`, y `npx vitest run agent-playbook/test/workflow-secrets.test.ts` cuando se toquen workflows. Después del push, CI en verde vía la skill `estado-ci`.

---

## Fuentes

1. OWASP GenAI — Top 10 for LLM Applications 2025: <https://genai.owasp.org/resource/owasp-top-10-for-llm-applications-2025/>
2. GitHub Docs — Code scanning setup types (default vs advanced): <https://docs.github.com/en/code-security/concepts/code-scanning/setup-types>
3. GitHub Changelog — Default setup available for all CodeQL languages: <https://github.blog/changelog/2023-06-28-code-scanning-default-setup-is-now-available-for-all-codeql-supported-languages-excluding-swift/>
4. CodeQL — Supported languages and frameworks: <https://codeql.github.com/docs/codeql-overview/supported-languages-and-frameworks/>
5. GitHub Blog — Supercharging GitHub Actions with Job Summaries: <https://github.blog/news-insights/product-news/supercharging-github-actions-with-job-summaries/>
6. OpenSSF Scorecard Action: <https://github.com/marketplace/actions/ossf-scorecard-action> · checks: <https://github.com/ossf/scorecard>
7. npm Docs — Trusted publishers: <https://docs.npmjs.com/trusted-publishers> · GitHub Changelog GA: <https://github.blog/changelog/2025-07-31-npm-trusted-publishing-with-oidc-is-generally-available/>
8. MADR: <https://adr.github.io/madr> · plantillas: <https://adr.github.io/adr-templates>
9. GitHub Docs — Create a composite action: <https://docs.github.com/en/actions/tutorials/create-actions/create-a-composite-action>
10. Git mailing list — `--follow` only works on a single file: <https://lore.kernel.ime.usp.br/git/20080129022141.GF24004@spearce.org/t/>
11. Underdog.io — What hiring managers look for on GitHub: <https://underdog.io/blog/what-hiring-managers-look-for-on-github>
12. SOLTECH — What hiring managers look for in a GitHub portfolio: <https://soltech.net/what-do-hiring-managers-actually-look-for-in-a-github-portfolio/>
13. Análisis de 1.000+ avisos de AI Engineer 2026: <https://alexeyondata.substack.com/p/what-1000-job-descriptions-reveal>
14. AI Engineer skills 2026 (3.449 avisos): <https://dev.to/gnana_6392e836fd500a957dc/ai-engineer-skills-companies-want-in-2026-3449-posting-analysis-5f9l>
15. GitHub Docs — Customizing your repository's social media preview: <https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/customizing-your-repositorys-social-media-preview>
16. GitHub Docs — Creating diagrams (Mermaid): <https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-diagrams>
17. OWASP GenAI LLM Top 10 2026: <https://genai.owasp.org/home/resources/owasp-genai-llm-top-10-2026/>
18. Help Net Security — OWASP 2026 LLM Top 10 released: <https://www.helpnetsecurity.com/2026/08/06/owasp-2026-llm-top-10-released/> · Infosecurity: <https://www.infosecurity-magazine.com/news/prompt-injection-llm-risk/>
19. Vitest — Reporters (`github-actions`, job summary): <https://vitest.dev/guide/reporters>
20. Martin Fowler — Architecture Decision Record: <https://www.martinfowler.com/bliki/ArchitectureDecisionRecord.html>
21. GitHub Docs — Managing your profile README: <https://docs.github.com/en/account-and-profile/how-tos/profile-customization/managing-your-profile-readme>
22. UAEval4RAG — Unanswerability Evaluation for RAG (ACL 2025): <https://arxiv.org/abs/2412.12300>
23. Claude API — Citations: <https://platform.claude.com/docs/en/build-with-claude/citations>
