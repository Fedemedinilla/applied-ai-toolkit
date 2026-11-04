// @vitest-environment jsdom
//
// The library in a browser-like global scope: window and document exist, and the PDF is built
// from the same entry with no Node API.

import { describe, expect, it } from 'vitest';
import { buildReceiptPdf } from '../src/index.ts';
import { order } from './helpers/fixtures.ts';

describe('in a browser environment', () => {
  it('builds the PDF and it can become a Blob for a download link', async () => {
    expect(typeof window).toBe('object');
    const bytes = await buildReceiptPdf(order({ notes: 'Sin 🥜' }));
    const blob = new Blob([bytes], { type: 'application/pdf' });
    expect(blob.size).toBe(bytes.length);
    expect(new TextDecoder().decode(bytes.subarray(0, 8))).toMatch(/^%PDF-1\.\d/);
  });
});
