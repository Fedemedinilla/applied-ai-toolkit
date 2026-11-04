// The draft's display segments and the two clipboard types.

import { describe, expect, it } from 'vitest';
import { blocks, copyContent, segments, textToHtml, textToPlain } from '../src/format.ts';

describe('segments', () => {
  it('splits bold and gaps, and a gap inside bold stays bold', () => {
    expect(segments('El **martes [COMPLETAR: fecha]** a las 8:30')).toEqual([
      { text: 'El ', bold: false, gap: false },
      { text: 'martes ', bold: true, gap: false },
      { text: '[COMPLETAR: fecha]', bold: true, gap: true },
      { text: ' a las 8:30', bold: false, gap: false },
    ]);
  });

  it('keeps an unpaired ** as text', () => {
    expect(segments('2 ** 3')).toEqual([{ text: '2 ** 3', bold: false, gap: false }]);
  });
});

describe('blocks', () => {
  it('groups paragraphs and consecutive list items', () => {
    const b = blocks('Estimadas familias:\n\nPrimera línea\nsegunda línea\n- uno\n- dos\nCierre\n\n\nFirma');
    expect(b.map((x) => x.kind)).toEqual(['paragraph', 'paragraph', 'list', 'paragraph', 'paragraph']);
    const list = b[2];
    expect(list?.kind === 'list' ? list.items.length : 0).toBe(2);
  });
});

describe('clipboard content', () => {
  it('escapes every character of the text in the HTML', () => {
    const html = textToHtml('<script>alert(1)</script> & "x"\n\n- <b>uno</b>');
    expect(html).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;x&quot;</p><ul><li>&lt;b&gt;uno&lt;/b&gt;</li></ul>');
  });

  it('keeps bold as <strong> in HTML and drops the markers in plain text', () => {
    expect(textToHtml('El **viernes**.')).toBe('<p>El <strong>viernes</strong>.</p>');
    expect(textToPlain('El **viernes**.\n\n- uno\n- dos')).toBe('El viernes.\n\n- uno\n- dos');
  });

  it('puts the title first and the English text after a rule', () => {
    const c = copyContent('Título <1>', 'Hola.', 'Hello.');
    expect(c.html).toBe('<p><strong>Título &lt;1&gt;</strong></p><p>Hola.</p><hr><p>Hello.</p>');
    expect(c.plain).toBe('Título <1>\n\nHola.\n\nHello.');
    expect(copyContent('T', 'Hola.', null).plain).toBe('T\n\nHola.');
    expect(copyContent('', 'Hola.', null)).toEqual({ html: '<p>Hola.</p>', plain: 'Hola.' });
  });

  it('keeps gaps visible in both types', () => {
    const c = copyContent('T', 'A las [COMPLETAR: hora].', null);
    expect(c.html).toContain('[COMPLETAR: hora]');
    expect(c.plain).toContain('[COMPLETAR: hora]');
  });
});
