// The public entry. Apps import from here and nowhere else in this folder.

export { buildReceipt, buildReceiptPdf, type BuiltReceipt, type ReceiptOptions } from './receipt.ts';
export {
  MAX_CENTS,
  MAX_PARTY_LINES,
  MAX_QUANTITY,
  ReceiptInputError,
  type ReceiptData,
  type ReceiptInputErrorCode,
  type ReceiptItem,
  type ReceiptParty,
  type ReceiptWarning,
} from './input.ts';
export { LABELS_EN, LABELS_ES, type ReceiptLabels } from './labels.ts';
export { formatCents, lineTotalCents, type MoneyFormat } from './money.ts';
export { isWinAnsi, toWinAnsiLine, toWinAnsiParagraphs, type Sanitized } from './winansi.ts';
