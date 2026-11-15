// What the page says for each server answer and each browser error, in Spanish.
// The server sends codes (server/handler.ts); the words live here.

export type TestAnswer =
  | { readonly kind: 'delivered'; readonly ttl: number }
  | { readonly kind: 'not_subscribed' }
  | { readonly kind: 'store_failed' }
  | { readonly kind: 'gone' }
  /** `reason` only when there was no status: `timeout`, or `unreachable` for a DNS, connection or TLS failure. */
  | { readonly kind: 'push_failed'; readonly statusCode: number | null; readonly reason?: 'timeout' | 'unreachable' }
  | { readonly kind: 'too_soon'; readonly seconds: number }
  | { readonly kind: 'not_configured' }
  | { readonly kind: 'other'; readonly status: number };

const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** Reads POST api/test's answer. The body is untrusted: anything unexpected falls to `other`. */
export function readTestAnswer(status: number, body: unknown): TestAnswer {
  const b = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  if (status === 200 && b['status'] === 'delivered') return { kind: 'delivered', ttl: num(b['ttl']) ?? 0 };
  switch (b['error']) {
    case 'not_subscribed':
      return { kind: 'not_subscribed' };
    case 'store_failed':
      return { kind: 'store_failed' };
    case 'gone':
      return { kind: 'gone' };
    case 'push_failed': {
      const reason = b['reason'] === 'timeout' || b['reason'] === 'unreachable' ? b['reason'] : null;
      return { kind: 'push_failed', statusCode: num(b['statusCode']), ...(reason === null ? {} : { reason }) };
    }
    case 'too_soon':
      return { kind: 'too_soon', seconds: num(b['retryAfterSeconds']) ?? 1 };
    case 'not_configured':
      return { kind: 'not_configured' };
    default:
      return { kind: 'other', status };
  }
}

function duration(seconds: number): string {
  if (seconds % 3600 === 0) return seconds === 3600 ? '1 hora' : `${seconds / 3600} horas`;
  return `${Math.round(seconds / 60)} minutos`;
}

export function testMessage(answer: TestAnswer): string {
  switch (answer.kind) {
    case 'delivered':
      return `Enviado. Si el dispositivo está apagado o sin señal, el servicio de push lo guarda hasta ${duration(answer.ttl)}.`;
    case 'not_subscribed':
      return 'El servidor no tenía este dispositivo (se reinició, o borró la suscripción). Ya se volvió a registrar: envía otra prueba.';
    case 'store_failed':
      // Not "disable and enable again": that advice destroys a subscription that may be fine.
      return 'El servidor no pudo leer su lista de suscripciones. No desactives los avisos: tu suscripción puede estar bien. Intenta de nuevo en un minuto.';
    case 'gone':
      return 'El servicio de push dice que esta suscripción ya no existe, y el servidor la borró. Toca Activar para crear una nueva.';
    case 'push_failed':
      if (answer.statusCode !== null) return `El servicio de push rechazó el envío (código ${answer.statusCode}). Revisa el diagnóstico del servidor.`;
      // "Try again" is the advice only for a timeout: a server with no way out fails every retry.
      if (answer.reason === 'unreachable') {
        return 'El servidor no pudo conectarse con el servicio de push (falla de DNS, conexión o certificado). Reintentar no lo arregla: revisa la red del servidor y su salida a internet.';
      }
      return 'El servicio de push no respondió a tiempo. Intenta de nuevo.';
    case 'too_soon':
      return `Espera ${answer.seconds} ${answer.seconds === 1 ? 'segundo' : 'segundos'} entre pruebas.`;
    case 'not_configured':
      return 'El servidor no tiene claves VAPID válidas. Revisa el diagnóstico del servidor.';
    case 'other':
      return `El servidor respondió ${answer.status}.`;
  }
}

/** What registering the subscription with the server again came to (src/app.ts, register). */
export type RegisterResult = 'ok' | 'store_failed' | 'unknown_service' | 'rejected' | 'network';

/**
 * The answer to a test the server refused as not_subscribed, once the page has tried to register
 * the device again. "Registered again" only when it was: otherwise the next test fails the same
 * way and the page has hidden why.
 */
export function reRegisterMessage(result: RegisterResult): string {
  switch (result) {
    case 'ok':
      return testMessage({ kind: 'not_subscribed' });
    case 'store_failed':
      return 'El servidor no tenía este dispositivo y no pudo volver a guardarlo (su lista de suscripciones falló o está llena). No desactives los avisos: tu suscripción puede estar bien. Intenta de nuevo en un minuto.';
    case 'network':
      return 'El servidor no tenía este dispositivo, y no se pudo conectar con él para registrarlo de nuevo. Recarga la página cuando haya conexión.';
    case 'unknown_service':
    case 'rejected':
      return 'El servidor no tenía este dispositivo y no aceptó registrarlo de nuevo. Revisa el diagnóstico del servidor.';
  }
}

/** A subscribe failure, as something the person can act on. A bare "it failed" lets nobody debug. */
export function explainError(error: unknown): string {
  const field = (key: 'name' | 'message'): string | null =>
    typeof error === 'object' && error !== null && key in error && typeof (error as Record<string, unknown>)[key] === 'string'
      ? String((error as Record<string, unknown>)[key])
      : null;
  const name = field('name') ?? '';
  const message = field('message') ?? String(error);
  if (name === 'NotAllowedError') return 'El navegador bloqueó los avisos para este sitio. Se habilitan en la configuración del sitio y luego se vuelve a intentar.';
  if (name === 'AbortError' || /push service|registration failed/iu.test(message)) {
    return 'El navegador no pudo conectarse a su servicio de push. Suele pasar con VPN, bloqueadores o redes que filtran ese tráfico.';
  }
  if (name === 'InvalidStateError') return 'Había una suscripción anterior con otra clave. Recarga la página e intenta de nuevo.';
  if (name === 'NotSupportedError') return 'Este navegador no admite avisos push.';
  return `No se pudieron activar los avisos. Motivo: ${name ? `${name}: ` : ''}${message}`;
}

export const PROBLEMS: Readonly<Record<string, string>> = {
  vapid_keys_missing: 'Faltan las claves VAPID en el servidor (PUSH_LAB_VAPID_PUBLIC_KEY y PUSH_LAB_VAPID_PRIVATE_KEY).',
  public_key_format: 'La clave pública no es un punto P-256 de 65 bytes en base64url.',
  private_key_format: 'La clave privada no tiene 32 bytes en base64url.',
  vapid_pair_mismatch: 'Las dos claves no son del mismo par. Genera un par nuevo y copia las dos.',
  subject_invalid: 'PUSH_LAB_VAPID_SUBJECT tiene que ser una URL mailto: o https:.',
  store_failed: 'El servidor no pudo leer su lista de suscripciones.',
  no_subscriptions: 'Todavía no hay ningún dispositivo suscrito.',
};
