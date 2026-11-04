// The example from the README, unchanged except for the import path.
import { createClient } from '@supabase/supabase-js';
import { expect, it } from 'vitest';
import { createFakeSupabase } from '../src/fake-auth.ts';

it('verifies the session locally with ES256', async () => {
  const fake = await createFakeSupabase();
  const supabase = createClient(fake.url, fake.publishableKey, {
    auth: { persistSession: true, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: fake.fetch },
  });

  await supabase.auth.signInWithOtp({ email: fake.user.email });
  await supabase.auth.verifyOtp({ email: fake.user.email, token: fake.otpCode, type: 'email' });
  fake.calls.length = 0;

  const { data } = await supabase.auth.getClaims();
  expect(data?.claims.sub).toBe(fake.user.id);
  expect(fake.calls).toEqual(['GET /auth/v1/.well-known/jwks.json']);
});
