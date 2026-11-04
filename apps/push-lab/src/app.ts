// The page: install instructions, enabling push, a test send, the badge counter and the server
// diagnosis. Every browser API comes in through AppDeps, so the tests run it in jsdom with fakes.

import { explainError, PROBLEMS, readTestAnswer, testMessage } from './messages.ts';
import type { Platform } from './platform.ts';
import { API, base64UrlToBytes, subscriptionBody, type WorkerMessage } from './wire.ts';

export interface SubscriptionLike {
  readonly endpoint: string;
  /** The key the subscription was made with. Some browsers report null; then nothing is compared. */
  readonly options?: { readonly applicationServerKey: ArrayBuffer | null };
  toJSON(): PushSubscriptionJSON;
  unsubscribe(): Promise<boolean>;
}

export interface RegistrationLike {
  readonly pushManager: {
    getSubscription(): Promise<SubscriptionLike | null>;
    subscribe(options: { userVisibleOnly: true; applicationServerKey: BufferSource }): Promise<SubscriptionLike>;
  };
}

/** Present only when the browser has a service worker container, PushManager and Notification. */
export interface PushEnv {
  permission(): NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
  /** navigator.serviceWorker.ready */
  ready(): Promise<RegistrationLike>;
  onWorkerMessage(listener: (message: WorkerMessage) => void): void;
  /** Asks the worker whether setAppBadge exists on its navigator; null when it does not answer. */
  askWorker(): Promise<{ badgeApi: boolean } | null>;
}

export interface InstallPrompt {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export interface AppDeps {
  readonly platform: Platform;
  /** fetch against the app's own URL; paths come from API. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  readonly push: PushEnv | null;
  /** The page's navigator.setAppBadge and clearAppBadge, or null. */
  readonly badge: { set(count: number): Promise<void>; clear(): Promise<void> } | null;
  onInstallPrompt(listener: (prompt: InstallPrompt) => void): void;
  onInstalled(listener: () => void): void;
  readonly search: string;
  now(): Date;
}

type Child = Node | string;

function h(doc: Document, tag: string, attrs: Record<string, string> = {}, ...children: Child[]): HTMLElement {
  const el = doc.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
  el.append(...children); // text nodes only; never innerHTML
  return el;
}

function need<T extends HTMLElement>(doc: Document, id: string): T {
  const el = doc.getElementById(id);
  if (!el) throw new Error(`push-lab: #${id} missing from index.html`);
  return el as T;
}

const LOG_LIMIT = 12;
const KIND_LABEL: Readonly<Record<string, string>> = { test: 'prueba', reminder: 'recordatorio' };

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function sameBytes(a: ArrayBuffer, b: Uint8Array): boolean {
  const left = new Uint8Array(a);
  return left.length === b.length && left.every((byte, i) => byte === b[i]);
}

export function mountApp(doc: Document, deps: AppDeps): { refresh(): Promise<void> } {
  const { platform, push } = deps;
  const el = {
    facts: need(doc, 'facts'),
    arrival: need(doc, 'arrival'),
    installBody: need(doc, 'install-body'),
    installButton: need<HTMLButtonElement>(doc, 'install-button'),
    installStatus: need(doc, 'install-status'),
    enableText: need(doc, 'enable-text'),
    enableButton: need<HTMLButtonElement>(doc, 'enable-button'),
    enableStatus: need(doc, 'enable-status'),
    testForm: need<HTMLFormElement>(doc, 'test-form'),
    testButton: need<HTMLButtonElement>(doc, 'test-button'),
    testBadge: need<HTMLInputElement>(doc, 'test-badge'),
    testDelay: need<HTMLInputElement>(doc, 'test-delay'),
    testStatus: need(doc, 'test-status'),
    badgeCount: need<HTMLOutputElement>(doc, 'badge-count'),
    badgeStatus: need(doc, 'badge-status'),
    diagnoseButton: need<HTMLButtonElement>(doc, 'diagnose-button'),
    diagnoseBody: need(doc, 'diagnose-body'),
    log: need(doc, 'log'),
  };

  let subscription: SubscriptionLike | null = null;
  let count = 0;
  let workerBadge: boolean | null = null;

  const log = (text: string): void => {
    const time = deps.now().toTimeString().slice(0, 8);
    el.log.prepend(h(doc, 'li', {}, h(doc, 'time', {}, time), ' ', text));
    while (el.log.children.length > LOG_LIMIT) el.log.lastElementChild?.remove();
  };

  const post = (path: string, body: unknown): Promise<Response> =>
    deps.fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  // ---- Facts about this device -------------------------------------------------------------

  const yesNo = (value: boolean | null): string => (value === null ? 'sin respuesta' : value ? 'sí' : 'no');
  const renderFacts = (): void => {
    const os = { ios: 'iPhone o iPad', android: 'Android', other: 'Otro (escritorio)' }[platform.os];
    const rows: Array<[string, string]> = [
      ['Sistema', os],
      ['Abierta como app instalada', yesNo(platform.installed)],
      ['Web Push en este navegador', yesNo(push !== null)],
      ['Permiso de avisos', push ? { granted: 'concedido', denied: 'bloqueado', default: 'sin pedir' }[push.permission()] : 'no aplica'],
      ['Suscripción en este navegador', subscription ? 'activa' : 'ninguna'],
      ['setAppBadge en la página', yesNo(deps.badge !== null)],
      ['setAppBadge en el service worker', push ? yesNo(workerBadge) : 'no aplica'],
    ];
    el.facts.replaceChildren(...rows.flatMap(([term, value]) => [h(doc, 'dt', {}, term), h(doc, 'dd', {}, value)]));
  };

  // ---- 1. Install ---------------------------------------------------------------------------

  const steps = (...items: string[]): HTMLElement => h(doc, 'ol', { class: 'steps' }, ...items.map((t) => h(doc, 'li', {}, t)));
  const renderInstall = (): void => {
    if (platform.installed) {
      el.installBody.replaceChildren(h(doc, 'p', {}, 'Listo: abriste Push Lab como app instalada.'));
      el.installButton.hidden = true;
      return;
    }
    if (platform.os === 'ios') {
      el.installBody.replaceChildren(
        h(doc, 'p', {}, 'En iPhone y iPad, las notificaciones web solo existen en la app agregada a la pantalla de inicio (iOS 16.4 o posterior). En una pestaña de Safari no hay permiso que pedir.'),
        steps(
          'Abre esta página en Safari.',
          'Toca Compartir (el cuadrado con la flecha hacia arriba).',
          'Elige "Agregar a inicio" y confirma.',
          'Abre Push Lab desde el ícono nuevo y sigue con el paso 2 ahí.',
        ),
      );
      return;
    }
    if (platform.os === 'android') {
      el.installBody.replaceChildren(
        h(doc, 'p', {}, 'En Android los avisos funcionan también sin instalar. El número sobre el ícono necesita la app instalada.'),
        steps('Toca Instalar, si aparece abajo.', 'Si no aparece: menú del navegador, luego "Instalar app" o "Agregar a la pantalla principal".'),
      );
      return;
    }
    el.installBody.replaceChildren(
      h(doc, 'p', {}, 'En escritorio los avisos funcionan sin instalar. El número sobre el ícono necesita la app instalada.'),
      steps('En Chrome o Edge: el ícono de instalar en la barra de direcciones, o Instalar abajo si aparece.', 'En Safari para Mac: Archivo, luego "Agregar al Dock".'),
    );
  };

  deps.onInstallPrompt((prompt) => {
    if (platform.installed) return;
    el.installButton.hidden = false;
    el.installButton.addEventListener(
      'click',
      async () => {
        el.installButton.disabled = true;
        await prompt.prompt().catch(() => undefined);
        const choice = await prompt.userChoice.catch(() => null);
        // One prompt per event: a button that cannot prompt again is hidden, not left to do nothing.
        el.installButton.hidden = true;
        el.installStatus.textContent =
          choice?.outcome === 'accepted' ? 'Instalada. Ábrela desde su ícono.' : 'Puedes instalarla más tarde desde el menú del navegador.';
      },
      { once: true },
    );
  });
  deps.onInstalled(() => {
    el.installButton.hidden = true;
    el.installStatus.textContent = 'Instalada. Ábrela desde su ícono para probar el número del globo.';
    log('App instalada.');
  });

  // ---- 2. Enable ----------------------------------------------------------------------------

  /** The server's VAPID public key; `none` when it has no pair it can sign with, `network` when it did not answer. */
  const serverKey = async (): Promise<{ key: string } | 'none' | 'network'> => {
    let response: Response;
    try {
      response = await deps.fetch(API.publicKey);
    } catch {
      return 'network';
    }
    const body = await readJson(response);
    return response.ok && typeof body === 'object' && body !== null && 'publicKey' in body && typeof body.publicKey === 'string'
      ? { key: body.publicKey }
      : 'none';
  };

  /** Registers the browser's subscription with the server. Idempotent there, so it runs on every load. */
  const register = async (sub: SubscriptionLike): Promise<'ok' | 'store_failed' | 'unknown_service' | 'rejected' | 'network'> => {
    const body = subscriptionBody(sub.toJSON());
    if (!body) return 'rejected';
    try {
      const response = await post(API.subscribe, body);
      if (response.ok) return 'ok';
      const answer = await readJson(response);
      const error = typeof answer === 'object' && answer !== null && 'error' in answer ? answer.error : null;
      if (error === 'unknown_push_service') return 'unknown_service';
      return error === 'store_failed' || error === 'store_full' ? 'store_failed' : 'rejected';
    } catch {
      return 'network';
    }
  };

  const setEnabled = (text: string, action: 'Activar' | 'Desactivar' | null): void => {
    el.enableText.textContent = text;
    el.enableButton.textContent = action ?? 'Activar';
    el.enableButton.disabled = action === null;
    el.testButton.disabled = subscription === null;
  };

  const refresh = async (): Promise<void> => {
    if (!push) {
      subscription = null;
      setEnabled(
        platform.pushNeedsInstall
          ? 'Primero agrega la app a la pantalla de inicio (paso 1). Las notificaciones aparecen recién ahí.'
          : 'Este navegador no tiene Web Push.',
        null,
      );
      renderFacts();
      return;
    }
    if (push.permission() === 'denied') {
      subscription = null;
      setEnabled('Los avisos están bloqueados para este sitio. Se habilitan desde la configuración del navegador.', null);
      renderFacts();
      return;
    }
    const registration = await push.ready();
    subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      // A subscription is bound to the public key it was made with. After the server's pair is
      // replaced, the browser still says "subscribed", every push is refused with a 403, and the
      // page would go on saying "Activados". So the key is compared on every load, and a stale
      // subscription is dropped on both sides.
      const current = await serverKey();
      const made = subscription.options?.applicationServerKey ?? null;
      if (typeof current === 'object' && made && !sameBytes(made, base64UrlToBytes(current.key))) {
        const stale = subscription;
        subscription = null;
        await post(API.unsubscribe, { endpoint: stale.endpoint }).catch(() => undefined);
        await stale.unsubscribe().catch(() => false);
        setEnabled('Recibe una notificación de prueba en este dispositivo.', 'Activar');
        el.enableStatus.textContent = 'El servidor cambió sus claves VAPID, y la suscripción anterior ya no sirve. Toca Activar para crear una nueva.';
        log('Suscripción hecha con otra clave del servidor: borrada.');
        renderFacts();
        return;
      }
      setEnabled('Activados en este dispositivo.', 'Desactivar');
      // The browser can say "subscribed" while the server lost the row: a restart of the
      // in-memory store, or a 410 that deleted it. Registering again on every load costs nothing
      // and brings the row back.
      const result = await register(subscription);
      if (result === 'store_failed') el.enableStatus.textContent = 'El servidor no pudo guardar la suscripción ahora. Se reintenta al recargar.';
    } else {
      setEnabled('Recibe una notificación de prueba en este dispositivo.', 'Activar');
    }
    renderFacts();
  };

  const enable = async (env: PushEnv): Promise<void> => {
    const answer = await serverKey();
    if (typeof answer !== 'object') {
      el.enableStatus.textContent =
        answer === 'network' ? 'No se pudo conectar con el servidor.' : 'El servidor no tiene claves VAPID válidas. Revisa el diagnóstico del servidor.';
      return;
    }
    const key = answer.key;
    // Asked from the click itself: browsers grant the prompt only to a user gesture.
    const permission = await env.requestPermission();
    if (permission !== 'granted') {
      el.enableStatus.textContent = permission === 'denied' ? 'Bloqueaste los avisos para este sitio.' : 'No se dio el permiso.';
      return;
    }
    const registration = await env.ready();
    const options = { userVisibleOnly: true as const, applicationServerKey: base64UrlToBytes(key) };
    let sub: SubscriptionLike;
    try {
      sub = await registration.pushManager.subscribe(options);
    } catch (error) {
      // A subscription made with another key (the server's pair was replaced) blocks a new one
      // until it is dropped.
      if (!(typeof error === 'object' && error !== null && 'name' in error && error.name === 'InvalidStateError')) throw error;
      await (await registration.pushManager.getSubscription())?.unsubscribe().catch(() => false);
      sub = await registration.pushManager.subscribe(options);
    }
    const result = await register(sub);
    if (result !== 'ok') {
      // Never leave the browser subscribed to a server that does not know it.
      await sub.unsubscribe().catch(() => false);
      el.enableStatus.textContent =
        result === 'store_failed'
          ? 'El servidor no pudo guardar la suscripción. Intenta de nuevo en un minuto.'
          : result === 'unknown_service'
            ? 'El servidor solo envía a los servicios de push de Apple, Google, Mozilla y Microsoft, y este navegador usa otro.'
            : 'El servidor no aceptó la suscripción.';
      return;
    }
    el.enableStatus.textContent = 'Avisos activados. Envía una prueba.';
    log('Suscripción creada y registrada en el servidor.');
  };

  const disable = async (sub: SubscriptionLike): Promise<void> => {
    try {
      await post(API.unsubscribe, { endpoint: sub.endpoint });
    } catch {
      // the browser side is what matters for "stop notifying me"
    }
    await sub.unsubscribe();
    el.enableStatus.textContent = 'Avisos desactivados en este dispositivo.';
    log('Suscripción borrada.');
  };

  el.enableButton.addEventListener('click', async () => {
    if (!push) return;
    el.enableButton.disabled = true;
    el.enableStatus.textContent = '';
    try {
      if (subscription) await disable(subscription);
      else await enable(push);
    } catch (error) {
      // The reason stays on screen, selectable: without it nobody can fix anything.
      el.enableStatus.textContent = explainError(error);
    }
    await refresh().catch(() => undefined);
  });

  // ---- 3. Test ------------------------------------------------------------------------------

  el.testForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const sub = subscription;
    if (!sub) return;
    const kindInput = el.testForm.querySelector<HTMLInputElement>('input[name="kind"]:checked');
    const kind = kindInput?.value === 'reminder' ? 'reminder' : 'test';
    el.testButton.disabled = true;
    el.testStatus.textContent = el.testDelay.checked ? 'Enviando en 5 segundos…' : 'Enviando…';
    try {
      const response = await post(API.test, {
        endpoint: sub.endpoint,
        kind,
        badge: el.testBadge.checked ? count : null,
        delaySeconds: el.testDelay.checked ? 5 : 0,
      });
      const answer = readTestAnswer(response.status, await readJson(response));
      el.testStatus.textContent = testMessage(answer);
      if (answer.kind === 'delivered') log(`Servidor: ${KIND_LABEL[kind] ?? kind} aceptada por el servicio de push.`);
      if (answer.kind === 'not_subscribed') await register(sub);
      if (answer.kind === 'gone') {
        await sub.unsubscribe().catch(() => false);
        await refresh().catch(() => undefined);
      }
    } catch {
      el.testStatus.textContent = 'No se pudo conectar con el servidor.';
    } finally {
      el.testButton.disabled = subscription === null;
    }
  });

  // ---- Badge ------------------------------------------------------------------------------

  const showCount = (): void => {
    el.badgeCount.value = String(count);
  };
  const applyBadge = async (n: number): Promise<void> => {
    if (!deps.badge) {
      el.badgeStatus.textContent = 'Esta página no tiene la API del globo (setAppBadge).';
      return;
    }
    try {
      if (n > 0) await deps.badge.set(n);
      else await deps.badge.clear();
      el.badgeStatus.textContent = n > 0 ? `Globo puesto en ${n}.` : 'Globo borrado.';
    } catch (error) {
      el.badgeStatus.textContent = `El sistema no aceptó el globo: ${explainError(error)}`;
    }
  };
  need(doc, 'badge-minus').addEventListener('click', () => {
    count = Math.max(0, count - 1);
    showCount();
  });
  need(doc, 'badge-plus').addEventListener('click', () => {
    count = Math.min(999, count + 1);
    showCount();
  });
  need(doc, 'badge-apply').addEventListener('click', () => void applyBadge(count));
  need(doc, 'badge-clear').addEventListener('click', () => {
    count = 0;
    showCount();
    void applyBadge(0);
  });

  // ---- Worker messages --------------------------------------------------------------------

  push?.onWorkerMessage((message) => {
    if (message.type !== 'push') return;
    const label = KIND_LABEL[message.kind] ?? message.kind;
    log(message.badge === null ? `El service worker recibió un aviso (${label}).` : `El service worker recibió un aviso (${label}) con globo ${message.badge}.`);
    // The second path for the badge: the page's navigator, for a device where the worker's
    // setAppBadge is missing or never resolves.
    if (message.badge !== null) {
      count = message.badge;
      showCount();
      void applyBadge(message.badge);
    }
  });

  // ---- Server diagnosis -------------------------------------------------------------------

  el.diagnoseButton.addEventListener('click', async () => {
    el.diagnoseButton.disabled = true;
    try {
      const response = await deps.fetch(API.diagnose);
      const body = await readJson(response);
      const d = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
      const problems = Array.isArray(d['problems']) ? d['problems'].filter((p): p is string => typeof p === 'string') : [];
      const store = typeof d['store'] === 'object' && d['store'] !== null ? (d['store'] as Record<string, unknown>) : {};
      const subs = typeof store['subscriptions'] === 'number' ? String(store['subscriptions']) : 'no se pudo contar';
      el.diagnoseBody.replaceChildren(
        h(doc, 'p', {}, d['ready'] === true ? 'Listo para enviar.' : 'Falta algo para enviar.'),
        h(doc, 'p', {}, `Dispositivos suscritos: ${subs}.`),
        ...(problems.length ? [h(doc, 'ul', {}, ...problems.map((p) => h(doc, 'li', {}, PROBLEMS[p] ?? p)))] : []),
      );
    } catch {
      el.diagnoseBody.replaceChildren(h(doc, 'p', {}, 'No se pudo conectar con el servidor.'));
    } finally {
      el.diagnoseButton.disabled = false;
    }
  });

  // ---- Start ------------------------------------------------------------------------------

  const params = new URLSearchParams(deps.search);
  if (params.get('from') === 'notification') el.arrival.textContent = 'Abriste la app desde un aviso.';
  if (params.get('redirected') === '1') el.arrival.textContent = 'Llegaste por una redirección 302, que el service worker dejó pasar sin tocarla.';

  renderInstall();
  renderFacts();
  showCount();
  if (push) {
    void push.askWorker().then((info) => {
      workerBadge = info?.badgeApi ?? null;
      renderFacts();
    });
  }
  void refresh().catch((error: unknown) => {
    el.enableText.textContent = explainError(error);
  });
  return { refresh };
}
