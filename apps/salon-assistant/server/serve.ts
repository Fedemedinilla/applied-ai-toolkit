// Serves the built page and the API on 127.0.0.1:8791:
//
//   npx vite build --config apps/salon-assistant/vite.config.ts
//   ASSISTANT_HISTORY_SECRET=$(openssl rand -hex 32) ANTHROPIC_API_KEY=sk-ant-... node apps/salon-assistant/server/serve.ts
//
// Without the key it still starts: /api/health and /api/assistant answer 503 and the page says
// the assistant is not available. Without a secret of at least 32 bytes it refuses to start.
// The server itself is server/static.ts; this file only reads the env and listens.

import { resolve } from 'node:path';
import { createApp } from './app.ts';
import { apiKeyFromEnv, historySecretFromEnv } from './env.ts';
import { createStaticServer } from './static.ts';

const PORT = 8791;
const ROOT = resolve(import.meta.dirname, '../../../dist/apps/salon-assistant');

const secret = historySecretFromEnv();
if (!secret) {
  process.stderr.write('Set ASSISTANT_HISTORY_SECRET to at least 32 bytes, for example: openssl rand -hex 32\n');
  process.exit(2);
}
const app = createApp({ apiKey: apiKeyFromEnv(), historySecret: secret });

createStaticServer({ root: ROOT, app, origin: `http://127.0.0.1:${PORT}` }).listen(PORT, '127.0.0.1', () => process.stdout.write(`http://127.0.0.1:${PORT}\n`));
