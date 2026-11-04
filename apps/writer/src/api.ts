// The page's side of POST ./api/draft: the request it sends, a shape check on what comes back,
// and the Spanish message for each error code. The check is written by hand, because zod would be
// most of the page's JavaScript; the server validated the same data with zod before sending it.

import type { DraftReport, LengthCheck, Note } from './checks.ts';

export interface ChatMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

export interface DraftRequest {
  readonly role: string;
  readonly category: string;
  readonly messages: readonly ChatMessage[];
}

export type ApiReply =
  | { readonly type: 'titles'; readonly titles: readonly string[]; readonly assistant: string }
  | { readonly type: 'draft'; readonly es: string; readonly en: string | null; readonly report: DraftReport; readonly assistant: string }
  | { readonly type: 'text'; readonly text: string; readonly assistant: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === 'string';
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every(isString);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

function isLength(v: unknown): v is LengthCheck {
  return (
    isObject(v) &&
    (v['lang'] === 'es' || v['lang'] === 'en') &&
    isInt(v['chars']) &&
    isInt(v['min']) &&
    isInt(v['max']) &&
    (v['status'] === 'short' || v['status'] === 'ok' || v['status'] === 'long')
  );
}

const isNote = (v: unknown): v is Note => isObject(v) && isString(v['code']) && (v['level'] === 'warn' || v['level'] === 'info') && isString(v['text']);

function isReport(v: unknown): v is DraftReport {
  return (
    isObject(v) &&
    Array.isArray(v['lengths']) &&
    v['lengths'].every(isLength) &&
    isStrings(v['placeholders']) &&
    Array.isArray(v['notes']) &&
    v['notes'].every(isNote)
  );
}

/** The reply, or null when it does not have the shape of any of the three. */
export function asReply(v: unknown): ApiReply | null {
  if (!isObject(v) || !isString(v['assistant']) || v['assistant'] === '') return null;
  const assistant = v['assistant'];
  if (v['type'] === 'titles' && isStrings(v['titles']) && v['titles'].length > 0) return { type: 'titles', titles: v['titles'], assistant };
  if (v['type'] === 'draft' && isString(v['es']) && (v['en'] === null || isString(v['en'])) && isReport(v['report'])) {
    return { type: 'draft', es: v['es'], en: v['en'], report: v['report'], assistant };
  }
  if (v['type'] === 'text' && isString(v['text'])) return { type: 'text', text: v['text'], assistant };
  return null;
}

export type FailureCode =
  | 'cap_reached'
  | 'model_unavailable'
  | 'model_unusable'
  | 'history_too_long'
  | 'bad_request'
  | 'category_not_for_role'
  | 'server_error'
  | 'network'
  | 'timeout'
  | 'bad_reply';

export const FAILURE_TEXT: Record<FailureCode, string> = {
  cap_reached: 'Se alcanzó el límite de uso de este mes. El servicio vuelve el mes próximo.',
  model_unavailable: 'El servicio de redacción está ocupado o no disponible. Intenta de nuevo en unos minutos.',
  model_unusable: 'La respuesta no se pudo usar. Intenta de nuevo.',
  history_too_long: 'Este borrador llegó al límite de cambios. Para seguir, empieza uno nuevo.',
  bad_request: 'El pedido no es válido. Revisa el rol, la categoría y el texto.',
  category_not_for_role: 'Ese rol no escribe esta categoría. Elige otra.',
  server_error: 'Hubo un error en el servidor. Intenta de nuevo.',
  network: 'No hay conexión con el servidor.',
  timeout: 'El servicio tardó demasiado en responder. Intenta de nuevo.',
  bad_reply: 'El servidor respondió algo que esta página no reconoce.',
};

const isFailureCode = (c: unknown): c is FailureCode => isString(c) && Object.hasOwn(FAILURE_TEXT, c);

export function failureFrom(status: number, body: unknown): FailureCode {
  const code = isObject(body) ? body['error'] : undefined;
  if (isFailureCode(code)) return code;
  return status >= 500 ? 'server_error' : 'bad_request';
}
