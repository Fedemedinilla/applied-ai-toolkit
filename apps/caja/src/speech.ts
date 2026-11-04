// Dictation through the browser's Web Speech API, when it exists. The TypeScript DOM lib does not
// declare SpeechRecognition, so the slice used here is declared locally.

export interface Recognition {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

export type RecognitionConstructor = new () => Recognition;

/** The constructor, or null when the browser has none. The button is hidden in that case. */
export function findRecognition(scope: object = globalThis): RecognitionConstructor | null {
  const s = scope as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
  const ctor = s.SpeechRecognition ?? s.webkitSpeechRecognition;
  return typeof ctor === 'function' ? (ctor as RecognitionConstructor) : null;
}

/** The error codes of the Web Speech API, in words the owner can act on. */
export function speechError(code: string): string {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'El navegador no dio permiso para usar el micrófono.';
    case 'network':
      return 'El dictado de este navegador necesita conexión. Escribí la frase.';
    case 'no-speech':
      return 'No escuché nada. Probá de nuevo, más cerca del micrófono.';
    case 'audio-capture':
      return 'No encontré un micrófono.';
    case 'aborted':
      return '';
    default:
      return 'El dictado falló. Escribí la frase.';
  }
}
