// The phrases tab: the parser's corpus, fetched the first time the tab opens, with a filter.

import { corpusLines, families, filterLines, readCorpus, type CorpusLine } from './corpus.ts';
import { fact, h, need, sentenceView } from './dom.ts';

function corpusItem(line: CorpusLine): HTMLElement {
  return h(
    'li',
    { class: `case ${line.agrees ? 'agrees' : 'differs'}` },
    h('p', { class: 'phrase' }, sentenceView(line.case.phrase, line.parsed?.spans ?? [])),
    h(
      'dl',
      { class: 'case-facts' },
      fact('Familia', line.case.family),
      fact('Tiene que dar', line.expected),
      fact('Da', line.got),
      fact('Resultado', line.agrees ? 'coincide' : line.case.known_conflict ? 'no coincide (conflicto conocido)' : 'no coincide'),
    ),
    h('p', { class: 'note', lang: 'en' }, line.case.note),
  );
}

/** Fills the tab. Resolves to false when the corpus could not be loaded, so the caller can retry. */
export async function mountCorpus(root: Document, deps: { loadCorpus(): Promise<unknown> }): Promise<boolean> {
  const list = need<HTMLElement>(root, '#corpus-list');
  const count = need<HTMLElement>(root, '#corpus-count');
  const query = need<HTMLInputElement>(root, '#corpus-q');
  const family = need<HTMLSelectElement>(root, '#corpus-family');
  const asks = need<HTMLInputElement>(root, '#corpus-asks');
  const filterForm = need<HTMLFormElement>(root, '#corpus-filter');

  count.textContent = 'Cargando las frases…';
  let lines: CorpusLine[];
  try {
    lines = corpusLines(readCorpus(await deps.loadCorpus()));
  } catch {
    count.textContent = 'No se pudieron cargar las frases. Con conexión, volvé a abrir esta pestaña.';
    return false;
  }
  for (const f of families(lines.map((l) => l.case))) family.append(h('option', { value: f }, f));

  const render = (): void => {
    const shown = filterLines(lines, { text: query.value, family: family.value, asksOnly: asks.checked });
    const agree = lines.filter((l) => l.agrees).length;
    count.textContent = `Mostrando ${shown.length} de ${lines.length} frases. El parser coincide con el corpus en ${agree} de ${lines.length}.`;
    list.replaceChildren(...shown.map(corpusItem));
  };
  filterForm.addEventListener('submit', (event) => event.preventDefault());
  filterForm.addEventListener('input', render);
  filterForm.addEventListener('change', render);
  render();
  return true;
}
