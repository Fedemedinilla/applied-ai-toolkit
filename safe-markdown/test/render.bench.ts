// renderMarkdown over a long model reply: every construct of the subset, repeated until the
// reply is just under the default 20,000-character cut, so the whole input is rendered.
//
//   npm run bench
//
// The number is compared with test/bench/baseline.json by `npm run bench:compare`.

import { expect, test } from 'vitest';
import { renderMarkdown } from '../src/index.ts';

const SECTION = [
  'Thanks for writing. **Your order** left the warehouse on *Tuesday*, and the carrier shows it at the last depot.',
  'You can follow it at [the tracking page](https://shop.example/track?id=0000) or on shop.example/orders, and the',
  'carrier keeps its own page at https://carrier.example/t/0000. If the link shows `IN_TRANSIT`, nothing is wrong.',
  '',
  '- The box holds **two** items: the kettle and its base.',
  '- A third item, the *filter*, ships apart and arrives later.',
  '- Write to help@shop.example with the order number if a box is missing.',
  '',
  '| Item | Status | Arrives |',
  '| --- | --- | --- |',
  '| Kettle | Shipped | Thursday |',
  '| Base | Shipped | Thursday |',
  '| Filter | Packing | Next week |',
  '',
  '```',
  'order 0000',
  '  kettle  x1  <shipped>',
  '  filter  x1  <packing>',
  '```',
  '',
  'A reply can also echo what the visitor typed, <b>tags</b> & all, and a line that looks like',
  'a link but is not one: [click here](javascript:alert(1)). Those stay as text.',
  '',
].join('\n');

const options = { internalHosts: ['shop.example'], externalHosts: ['carrier.example'] };
const REPEATS = Math.floor(19_900 / SECTION.length);
const reply = SECTION.repeat(REPEATS);

test('safe-markdown: render a long reply', async ({ bench }) => {
  let html = '';
  await bench('safe-markdown/render-long-reply', { writeResult: 'reports/bench/raw/safe-markdown/render-long-reply.json' }, () => {
    html = renderMarkdown(reply, options);
  }).run();
  // The whole reply was rendered, not cut: every section's table and code block is in the output.
  expect(reply.length).toBeGreaterThan(15_000);
  expect(reply.length).toBeLessThanOrEqual(20_000);
  expect(html.split('<table').length - 1).toBe(REPEATS);
  expect(html.split('<pre').length - 1).toBe(REPEATS);
  expect(html).not.toContain('<b>');
});
