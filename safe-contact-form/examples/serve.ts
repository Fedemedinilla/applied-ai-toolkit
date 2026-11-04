// A local server for examples/form.html, on 127.0.0.1:8790.
//
//   node safe-contact-form/examples/serve.ts               no transport: every send answers 503
//   node safe-contact-form/examples/serve.ts --print-mail  prints both emails instead of sending them
//   RESEND_API_KEY=re_... CONTACT_TO=you@your.domain CONTACT_FROM="Site <hello@your.domain>" \
//     node safe-contact-form/examples/serve.ts             sends through Resend
//
// The destination comes from CONTACT_TO, never from the code.

import { readFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { createContactHandler, resendTransport, type MailTransport } from '../src/index.ts';

const here = new URL('./', import.meta.url);
const printMail = process.argv.includes('--print-mail');
const key = process.env['RESEND_API_KEY'];

const printer: MailTransport = {
  async send(m) {
    process.stdout.write(`\n--- to ${m.to} (reply to ${m.replyTo})\nSubject: ${m.subject}\n\n${m.text}\n`);
    return { id: `printed-${Date.now()}` };
  },
};

const handler = createContactHandler({
  to: process.env['CONTACT_TO'] ?? 'owner@studio.example',
  from: process.env['CONTACT_FROM'] ?? 'Example Studio <hello@studio.example>',
  publicAddress: process.env['CONTACT_PUBLIC'] ?? 'hello@studio.example',
  siteName: 'Example Studio',
  homeUrl: { en: '/', es: '/' },
  transport: key ? resendTransport({ apiKey: key }) : printMail ? printer : null,
  log: (e) => process.stdout.write(`${JSON.stringify(e)}\n`),
});

// Node accepts TRACE, CONNECT and others that `new Request` throws on; they never reach the handler.
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
// Above the handler's own 32 KiB limit, so the handler still answers its 413 first; this one only
// stops the server from buffering an unbounded body.
const LIMIT = 64 * 1024;

function failed(res: ServerResponse, status: number): void {
  if (!res.headersSent) res.writeHead(status, { connection: 'close' });
  res.end();
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1:8790');
  if (url.pathname === '/api/contact') {
    const method = req.method ?? 'GET';
    if (!METHODS.has(method)) {
      res.writeHead(405, { allow: 'GET, POST' }).end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.byteLength;
      if (size <= LIMIT) chunks.push(c);
    });
    req.on('error', () => failed(res, 400));
    req.on('end', () => {
      if (size > LIMIT) return failed(res, 413);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
      const body = method === 'GET' || method === 'HEAD' ? null : Buffer.concat(chunks);
      Promise.resolve()
        .then(() => handler(new Request(url, { method, headers, body }), { clientAddress: req.socket.remoteAddress ?? 'unknown' }))
        .then(async (r) => {
          res.writeHead(r.status, Object.fromEntries(r.headers));
          res.end(Buffer.from(await r.arrayBuffer()));
        })
        .catch(() => failed(res, 500));
    });
    return;
  }
  const file = url.pathname === '/' ? 'form.html' : url.pathname === '/form.js' ? 'form.js' : null;
  if (!file) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8' });
  res.end(readFileSync(new URL(file, here)));
});

server.listen(8790, '127.0.0.1', () => {
  const mode = key ? 'sending through Resend' : printMail ? 'printing mail to stdout' : 'no transport, sends answer 503';
  process.stdout.write(`http://127.0.0.1:8790 (${mode})\n`);
});
