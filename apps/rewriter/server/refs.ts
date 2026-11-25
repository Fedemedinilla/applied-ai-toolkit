// style-refs' principles, sources, examples and channel guides, read from the repository and checked with
// style-refs' own schemas, as prose-rewriter's CLI does (prose-rewriter/src/cli.ts loadRefs). The
// rewriter's prompt shows them; without them it shows none. Read once, at start, so a broken file
// stops the server before the first request. Each file is named in full so the import fences see
// which published data the app reads (import-fences/repo.config.ts).

import { readFileSync } from 'node:fs';
import type { PromptRefs } from '../../../prose-rewriter/src/index.ts';
import { Channel, Example, Principle, Source } from '../../../style-refs/src/index.ts';

const FILES = {
  sources: [new URL('../../../style-refs/sources.json', import.meta.url)],
  principles: [new URL('../../../style-refs/principles/es.json', import.meta.url), new URL('../../../style-refs/principles/en.json', import.meta.url)],
  examples: [new URL('../../../style-refs/examples/es.json', import.meta.url), new URL('../../../style-refs/examples/en.json', import.meta.url)],
  channels: [new URL('../../../style-refs/channels/es.json', import.meta.url), new URL('../../../style-refs/channels/en.json', import.meta.url)],
};

function array(url: URL): unknown[] {
  const data: unknown = JSON.parse(readFileSync(url, 'utf8'));
  if (!Array.isArray(data)) throw new Error(`${url.pathname} is not a JSON array`);
  return data;
}

export function loadRefs(): PromptRefs {
  return {
    sources: FILES.sources.flatMap(array).map((s) => Source.parse(s)),
    principles: FILES.principles.flatMap(array).map((p) => Principle.parse(p)),
    examples: FILES.examples.flatMap(array).map((e) => Example.parse(e)),
    channels: FILES.channels.flatMap(array).map((c) => Channel.parse(c)),
  };
}
