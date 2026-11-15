import { describe, expect, it } from 'vitest';
import { readEnv } from '../server/env.ts';

describe('readEnv', () => {
  it('builds the default public URL from the port it will listen on', () => {
    for (const PORT of ['', 'abc', '70000', '4331.5', '0']) {
      const env = readEnv({ PORT });
      expect(env.port).toBe(4331);
      expect(env.publicBaseUrl).toBe('http://localhost:4331');
    }
    expect(readEnv({ PORT: '8080' })).toMatchObject({ port: 8080, publicBaseUrl: 'http://localhost:8080' });
    expect(readEnv({ PORT: 'abc', CHAT_WIDGET_PUBLIC_URL: 'https://widget.example' }).publicBaseUrl).toBe('https://widget.example');
  });
});
