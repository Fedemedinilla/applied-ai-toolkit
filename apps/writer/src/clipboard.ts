// Copying a draft as rich text: text/html for editors that keep bold and lists (mail clients,
// word processors, the school platform's editor) and text/plain for everything else, in one
// clipboard item. Browsers without ClipboardItem, or that refuse the write, get plain text.

import type { CopyContent } from './format.ts';

export interface ClipboardPort {
  /** Writes both types. Missing when the browser has no ClipboardItem. */
  readonly writeRich?: (content: CopyContent) => Promise<void>;
  readonly writeText?: (text: string) => Promise<void>;
}

export type CopyResult = 'rich' | 'plain' | 'failed';

export async function copyDraft(port: ClipboardPort, content: CopyContent): Promise<CopyResult> {
  if (port.writeRich) {
    try {
      await port.writeRich(content);
      return 'rich';
    } catch {
      // Permission denied or a type the browser will not write: fall back to plain text.
    }
  }
  if (port.writeText) {
    try {
      await port.writeText(content.plain);
      return 'plain';
    } catch {
      return 'failed';
    }
  }
  return 'failed';
}

/** The browser's clipboard, when the page has one (secure contexts only). */
export function browserClipboard(): ClipboardPort {
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  if (!clipboard) return {};
  const writeText = (text: string) => clipboard.writeText(text);
  if (typeof ClipboardItem !== 'function' || typeof clipboard.write !== 'function') return { writeText };
  return {
    writeText,
    writeRich: (content) =>
      clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([content.html], { type: 'text/html' }),
          'text/plain': new Blob([content.plain], { type: 'text/plain' }),
        }),
      ]),
  };
}
