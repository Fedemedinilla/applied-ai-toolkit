// The panel page: create a password from an invite, log in, edit what the assistant knows, copy the
// install line. It talks only to ./api/ on its own origin; the session is an HttpOnly cookie that
// this script never sees. Every value from the server is set with textContent or .value.

type Json = Record<string, unknown>;

const $ = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`panel: #${id} is missing`);
  return node as T;
};

const views = ['view-loading', 'view-invite', 'view-login', 'view-editor'] as const;

function show(view: (typeof views)[number]): void {
  for (const id of views) $(id).hidden = id !== view;
}

/**
 * Status regions: one at the top for the login and invite forms, one under Save and one under
 * Copy, so the answer appears where the person is looking. Only one holds text at a time.
 */
const regions = ['status', 'save-status', 'copy-status'] as const;

function say(text: string, error = false, where: (typeof regions)[number] = 'status'): void {
  for (const id of regions) {
    const region = $(id);
    region.textContent = id === where ? text : '';
    region.classList.toggle('error', id === where && error);
  }
}

/** The panel field each name in a refused patch points at. */
const FIELD_IDS: Readonly<Record<string, string>> = {
  botName: 'f-botName',
  welcome: 'f-welcome',
  tonePreset: 'f-tonePreset',
  tone: 'f-tone',
  context: 'f-context',
  faq: 'f-faq',
  suggestedQuestions: 'f-suggested',
};

/** Marks the fields the server named as invalid and moves focus to the first one. */
function markInvalid(fields: readonly string[]): void {
  for (const id of Object.values(FIELD_IDS)) $(id).removeAttribute('aria-invalid');
  const ids = fields.map((f) => FIELD_IDS[f.split('.')[0] ?? '']).filter((id): id is string => id !== undefined);
  for (const id of ids) $(id).setAttribute('aria-invalid', 'true');
  if (ids[0]) $(ids[0]).focus();
}

const ERRORS: Readonly<Record<string, string>> = {
  bad_credentials: 'El correo o la contraseña no coinciden.',
  rate_limited: 'Demasiados intentos. Espera un minuto.',
  invite_invalid: 'El enlace no es válido, ya se usó o venció. Pide uno nuevo.',
  bad_request: 'Revisa los campos: alguno supera su largo máximo.',
  unauthorized: 'Tu sesión terminó. Vuelve a ingresar.',
  unavailable: 'El servicio no responde. Inténtalo de nuevo más tarde.',
};
const errorText = (code: unknown): string => (typeof code === 'string' ? ERRORS[code] : undefined) ?? 'Algo falló. Inténtalo de nuevo.';

async function api(path: string, method: string, body?: unknown): Promise<{ status: number; json: Json }> {
  try {
    const response = await fetch(`./api/${path}`, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json: unknown = await response.json().catch(() => ({}));
    return { status: response.status, json: typeof json === 'object' && json !== null ? (json as Json) : {} };
  } catch {
    return { status: 0, json: { error: 'unavailable' } };
  }
}

const field = <T extends HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(name: string): T => $<T>(`f-${name}`);

function fill(content: Json): void {
  for (const name of ['botName', 'welcome', 'tonePreset', 'tone', 'context', 'faq']) {
    const value = content[name];
    field(name).value = typeof value === 'string' ? value : '';
  }
  const questions = content['suggestedQuestions'];
  $<HTMLTextAreaElement>('f-suggested').value = Array.isArray(questions) ? questions.filter((q) => typeof q === 'string').join('\n') : '';
}

async function openEditor(): Promise<void> {
  const { status: code, json } = await api('me', 'GET');
  if (code !== 200) {
    show('view-login');
    if (code !== 401) say(errorText(json['error']), true);
    return;
  }
  fill(typeof json['content'] === 'object' && json['content'] !== null ? (json['content'] as Json) : {});
  $('snippet').textContent = typeof json['snippet'] === 'string' ? json['snippet'] : '';
  show('view-editor');
}

async function busy<T>(form: HTMLFormElement, work: () => Promise<T>): Promise<T> {
  const button = form.querySelector('button[type="submit"]');
  if (button instanceof HTMLButtonElement) button.disabled = true;
  try {
    return await work();
  } finally {
    if (button instanceof HTMLButtonElement) button.disabled = false;
  }
}

$<HTMLFormElement>('login-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  void busy(form, async () => {
    const email = $<HTMLInputElement>('login-email').value.trim();
    const password = $<HTMLInputElement>('login-password').value;
    if (email === '' || password === '') return say('Completa el correo y la contraseña.', true);
    const { status: code, json } = await api('login', 'POST', { email, password });
    if (code !== 200) return say(errorText(json['error']), true);
    $<HTMLInputElement>('login-password').value = '';
    say('Ingresaste.');
    await openEditor();
  });
});

$<HTMLFormElement>('content-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  void busy(form, async () => {
    const suggested = $<HTMLTextAreaElement>('f-suggested')
      .value.split('\n')
      .map((q) => q.trim())
      .filter((q) => q !== '');
    if (suggested.length > 4) {
      markInvalid(['suggestedQuestions']);
      return say('Hasta 4 preguntas sugeridas.', true, 'save-status');
    }
    const patch = {
      botName: field('botName').value.trim(),
      welcome: field('welcome').value.trim(),
      tonePreset: field('tonePreset').value,
      tone: field('tone').value,
      context: field('context').value,
      faq: field('faq').value,
      suggestedQuestions: suggested,
    };
    const { status: code, json } = await api('content', 'PUT', patch);
    if (code === 401) {
      show('view-login');
      return say(errorText('unauthorized'), true);
    }
    const fields = Array.isArray(json['fields']) ? json['fields'].filter((f): f is string => typeof f === 'string') : [];
    markInvalid(code === 200 ? [] : fields);
    say(code === 200 ? 'Guardado. El asistente usa los cambios desde el próximo mensaje.' : errorText(json['error']), code !== 200, 'save-status');
  });
});

$('logout').addEventListener('click', () => {
  void api('logout', 'POST').then(() => {
    show('view-login');
    say('Saliste del panel.');
  });
});

$('copy').addEventListener('click', () => {
  const text = $('snippet').textContent ?? '';
  const failed = (): void => say('No se pudo copiar. Selecciona el texto y cópialo a mano.', true, 'copy-status');
  // The Clipboard API exists only in a secure context (https, or localhost).
  if (!navigator.clipboard) return failed();
  navigator.clipboard.writeText(text).then(() => say('Código copiado.', false, 'copy-status'), failed);
});

async function start(): Promise<void> {
  const match = /^#invite=([A-Za-z0-9_.-]+)$/u.exec(location.hash);
  if (!match?.[1]) return openEditor();
  const token = match[1];
  // The token leaves the address bar at once, so it is not kept in history or shared by accident.
  history.replaceState(null, '', location.pathname);
  const { status: code, json } = await api('invite/check', 'POST', { token });
  if (code !== 200) {
    show('view-login');
    return say(errorText(json['error']), true);
  }
  $('invite-for').textContent = `Para la cuenta ${typeof json['email'] === 'string' ? json['email'] : ''}.`;
  show('view-invite');
  $<HTMLFormElement>('invite-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    void busy(form, async () => {
      const password = $<HTMLInputElement>('invite-password').value;
      if (password.length < 10) return say('La contraseña necesita al menos 10 caracteres.', true);
      if (password !== $<HTMLInputElement>('invite-repeat').value) return say('Las contraseñas no coinciden.', true);
      const result = await api('invite/accept', 'POST', { token, password });
      if (result.status !== 200) return say(errorText(result.json['error']), true);
      say('Contraseña creada.');
      await openEditor();
    });
  });
}

void start();
