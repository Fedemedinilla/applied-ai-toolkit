// The one place the backend reads the environment. Everything else gets these values as arguments.

export interface ServerEnv {
  /** Null: chat answers 503 and the widget shows "not available"; config and the panel still work. */
  readonly apiKey: string | null;
  /** HMAC key for sessions and invites, at least 32 bytes. Null: serve.ts makes one per process. */
  readonly sessionSecret: string | null;
  /** The operator's password for /panel/api/admin/invite, at least 16 characters. Null: that route answers 401. */
  readonly adminPassword: string | null;
  /** Where browsers reach this server. The panel's Origin check, the snippet and invite links use it. */
  readonly publicBaseUrl: string;
  readonly port: number;
  readonly host: string;
}

const nonEmpty = (value: string | undefined): string | null => {
  const v = value?.trim() ?? '';
  return v === '' ? null : v;
};

export function readEnv(env: Readonly<Record<string, string | undefined>> = process.env): ServerEnv {
  const port = Number(env['PORT'] ?? '4331');
  return {
    apiKey: nonEmpty(env['ANTHROPIC_API_KEY']),
    sessionSecret: nonEmpty(env['CHAT_WIDGET_SESSION_SECRET']),
    adminPassword: nonEmpty(env['CHAT_WIDGET_ADMIN_PASSWORD']),
    publicBaseUrl: nonEmpty(env['CHAT_WIDGET_PUBLIC_URL']) ?? `http://localhost:${port}`,
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 4331,
    host: nonEmpty(env['HOST']) ?? '127.0.0.1',
  };
}
