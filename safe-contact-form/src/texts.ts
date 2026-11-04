/**
 * Everything the visitor reads, in English and neutral Spanish. Each text can be replaced through
 * the handler's `texts` option. No text here contains a dash used as punctuation: these are the
 * owner's words to a stranger, and the source's owner wanted none.
 */
export type Lang = 'en' | 'es';

export interface PageText {
  readonly title: string;
  readonly body: string;
}

export interface Texts {
  readonly back: string;
  /** Pages for the no-JS submit. `{address}` is replaced by the public address. */
  readonly pages: {
    readonly ok: PageText;
    readonly invalid: PageText;
    readonly limited: PageText;
    readonly unavailable: PageText;
    readonly forbidden: PageText;
  };
  readonly ack: {
    /** `{site}` is replaced by the site name. */
    readonly subject: string;
    /** `{name}` is replaced by the greeting. */
    readonly hello: string;
    readonly received: string;
    readonly copy: string;
    /** Written instead of each link removed from the quote. */
    readonly linkPlaceholder: string;
    /** The greeting when the name is empty after the links are removed. */
    readonly helloNoName: string;
  };
}

export const TEXTS: Readonly<Record<Lang, Texts>> = {
  en: {
    back: 'Back to the site',
    pages: {
      ok: { title: 'Message received.', body: 'You will get a reply at the address you left.' },
      invalid: { title: 'Some details are missing.', body: 'The form needs your name, one valid email address and the message. Go back to check it; what you wrote is still there in most browsers.' },
      limited: { title: 'Too many messages in a row.', body: 'Try again in a few minutes, or write directly to {address}.' },
      unavailable: { title: 'The message could not be sent.', body: 'The problem is on our side. Write directly to {address}.' },
      forbidden: { title: 'This form only accepts messages sent from its own page.', body: 'Open the contact page again and send it from there, or write to {address}.' },
    },
    ack: {
      subject: 'We got your message · {site}',
      hello: 'Hi {name},',
      received: 'Your message reached us. We will reply to this same address.',
      copy: 'A copy of what you wrote:',
      linkPlaceholder: '[link]',
      helloNoName: 'Hi,',
    },
  },
  es: {
    back: 'Volver al sitio',
    pages: {
      ok: { title: 'Recibimos tu mensaje.', body: 'Te vamos a responder al correo que dejaste.' },
      invalid: { title: 'Faltan datos.', body: 'El formulario necesita tu nombre, un correo válido y el mensaje. Vuelve atrás para revisarlo; en la mayoría de los navegadores lo que escribiste sigue ahí.' },
      limited: { title: 'Demasiados envíos seguidos.', body: 'Intenta de nuevo en unos minutos, o escribe directamente a {address}.' },
      unavailable: { title: 'No se pudo enviar el mensaje.', body: 'El problema es nuestro. Escribe directamente a {address}.' },
      forbidden: { title: 'Este formulario solo acepta mensajes enviados desde su propia página.', body: 'Abre otra vez la página de contacto y envíalo desde ahí, o escribe a {address}.' },
    },
    ack: {
      subject: 'Recibimos tu mensaje · {site}',
      hello: 'Hola, {name}:',
      received: 'Tu mensaje nos llegó. Te respondemos a este mismo correo.',
      copy: 'Copia de lo que escribiste:',
      linkPlaceholder: '[enlace]',
      helloNoName: 'Hola:',
    },
  },
};

export const fill = (template: string, values: Readonly<Record<string, string>>): string =>
  template.replace(/\{(\w+)\}/g, (m, k: string) => values[k] ?? m);
