// Serves the build, the widget API and the panel API on one origin, with the fictional demo tenant:
//
//   npx vite build --config apps/chat-widget/vite.config.ts
//   node apps/chat-widget/server/serve.ts            # http://localhost:4331/
//
// Environment (server/env.ts): ANTHROPIC_API_KEY, CHAT_WIDGET_SESSION_SECRET,
// CHAT_WIDGET_ADMIN_PASSWORD, CHAT_WIDGET_PUBLIC_URL, PORT, HOST. Without a key the widget mounts
// and every message answers "not available". The store is in memory: a restart forgets everything.

import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.ts';
import { createAuth, INVITE_MAX_AGE_S } from './auth.ts';
import { DEMO_TENANT } from './demo-tenant.ts';
import { readEnv } from './env.ts';
import { DEFAULT_LIMITS } from './limits.ts';
import { createChatModel } from './model.ts';
import { createNodeServer, SOCKET_IP } from './node-http.ts';
import { inviteUrl } from './panel-api.ts';
import { MemoryStore } from './store.ts';

const env = readEnv();
const dir = fileURLToPath(new URL('../../../dist/apps/chat-widget/', import.meta.url));

const secret = env.sessionSecret ?? randomBytes(32).toString('base64url');
if (!env.sessionSecret) console.warn('chat-widget: CHAT_WIDGET_SESSION_SECRET is not set; sessions end when the process stops');
const auth = createAuth(secret, () => new Date());

const store = new MemoryStore();
store.putTenant({ ...DEMO_TENANT });

const model = env.apiKey ? createChatModel({ apiKey: env.apiKey, timeZone: DEFAULT_LIMITS.timeZone }) : null;
const handler = createApp({
  store,
  gateway: model?.gateway ?? null,
  auth,
  publicBaseUrl: env.publicBaseUrl,
  adminPassword: env.adminPassword,
  clientIp: (request) => SOCKET_IP.get(request) ?? null,
  log: (event, data) => console.warn(JSON.stringify({ source: 'chat-widget', event, ...data })),
});

// The demo owner gets an invite at startup, so the panel can be tried without the admin route.
const nonce = crypto.randomUUID();
await store.setInviteNonce(DEMO_TENANT.tenantId, nonce);

createNodeServer({ handler, dir }).listen(env.port, env.host, () => {
  console.log(`chat-widget: ${env.publicBaseUrl}/ (demo page), serving ${dir}`);
  console.log(`chat-widget: model ${model ? 'on' : 'off (no ANTHROPIC_API_KEY)'}`);
  console.log(`chat-widget: demo owner invite, valid 48 h: ${inviteUrl(env.publicBaseUrl, auth.sign('invite', DEMO_TENANT.tenantId, nonce, INVITE_MAX_AGE_S))}`);
});
