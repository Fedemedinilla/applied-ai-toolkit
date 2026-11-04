// Serves the built app and its API on one origin:
//
//   npx vite build --config apps/push-lab/vite.config.ts
//   node --env-file=apps/push-lab/.env apps/push-lab/server/serve.ts
//
// Reads PUSH_LAB_VAPID_PUBLIC_KEY, PUSH_LAB_VAPID_PRIVATE_KEY and PUSH_LAB_VAPID_SUBJECT
// (node apps/push-lab/scripts/vapid.ts prints a fresh set), PORT (default 4330) and HOST
// (default 127.0.0.1). Without keys it still starts, and /api/diagnose says what is missing.
//
// Push and service workers need a secure context: http://localhost works on the same machine,
// and a phone needs HTTPS, from a host or a tunnel in front of this port.

import { fileURLToPath } from 'node:url';
import { createHandler } from './handler.ts';
import { createNodeServer } from './node-server.ts';
import { webPushSender } from './push.ts';
import { memoryStore } from './store.ts';
import { checkVapid, readVapidConfig } from './vapid.ts';

const dir = fileURLToPath(new URL('../../../dist/apps/push-lab/', import.meta.url));
const vapid = readVapidConfig(process.env);
const handler = createHandler({ store: memoryStore(), send: webPushSender(vapid), vapid });
const port = Number(process.env['PORT'] ?? 4330);
const host = process.env['HOST'] ?? '127.0.0.1';

createNodeServer({ handler, dir }).listen(port, host, () => {
  const check = checkVapid(vapid);
  console.log(`push-lab: http://${host}:${port}/ serving ${dir}`);
  console.log(check.ok ? 'push-lab: VAPID keys ok' : 'push-lab: VAPID keys missing or invalid, see /api/diagnose');
});
