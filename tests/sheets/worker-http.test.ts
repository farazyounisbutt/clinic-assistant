import { expect, it } from 'vitest';
import { googleJson } from '../../src/adapters/sheets/http.js';

it('uses a Worker-supported redirect policy without following credential-bearing redirects', async () => {
  let calls = 0;
  await expect(
    googleJson(
      async (url, init) => {
        calls++;
        // Use the real workerd Request constructor: a fake fetch alone missed this.
        const request = new Request(url, init);
        expect(request.redirect).toBe('manual');
        return new Response(null, {
          status: 302,
          headers: { Location: 'https://redirect.example.invalid/' },
        });
      },
      'https://oauth2.googleapis.com/token',
      { method: 'POST', body: 'synthetic-test-data' },
      1000,
      true,
    ),
  ).rejects.toMatchObject({ category: 'Schema' });
  expect(calls).toBe(1);
});
