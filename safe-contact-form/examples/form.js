// Progressive enhancement for form.html. Without this file the form posts natively and the server
// answers with a page; with it, the submit goes as JSON and the answer appears in the status line.
const form = document.querySelector('[data-contact]');
if (form) {
  const rendered = document.createElement('input');
  rendered.type = 'hidden';
  rendered.name = 'rendered_at';
  rendered.value = String(Date.now());
  form.append(rendered);
  const status = form.querySelector('#status');
  const button = form.querySelector('button');
  const say = (text, isError) => {
    status.textContent = text;
    status.classList.toggle('error', isError);
  };
  const MESSAGES = {
    invalid: 'Revisa el nombre, el correo y el mensaje.',
    limited: 'Demasiados envíos seguidos. Intenta en unos minutos.',
    not_configured: 'No se pudo enviar. Escríbenos directamente por correo.',
    send_failed: 'No se pudo enviar. Escríbenos directamente por correo.',
    origin: 'Abre otra vez esta página y envíalo desde aquí.',
  };
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    button.disabled = true;
    say('Enviando…', false);
    try {
      const res = await fetch(form.action, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(Object.fromEntries(new FormData(form))),
      });
      const data = await res.json().catch(() => null);
      if (data && data.ok) {
        say(data.acknowledged ? 'Recibimos tu mensaje. Te enviamos una copia.' : 'Recibimos tu mensaje.', false);
        form.reset();
      } else {
        say(MESSAGES[data && data.error] || MESSAGES.send_failed, true);
      }
    } catch {
      say('Sin conexión. Intenta de nuevo.', true);
    } finally {
      button.disabled = false;
    }
  });
}
