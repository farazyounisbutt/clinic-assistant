import { expect, it } from 'vitest';
import { MetaClient } from '../../src/adapters/whatsapp/client.js';

it('invokes the Worker fetch function without binding it to the client', async () => {
  let failure = '';
  const http: typeof fetch = async function (this: unknown) {
    try {
      // Invalid URL prevents network access while exercising native receiver validation.
      await Reflect.apply(fetch, this, ['not-a-valid-url']);
    } catch (error) {
      failure = error instanceof Error ? error.message : 'Unexpected error';
    }
    expect(failure).not.toMatch(/illegal invocation|this|receiver/i);
    return Response.json({ messages: [{ id: 'wamid.synthetic' }] });
  };
  await expect(
    new MetaClient({ META_ACCESS_TOKEN: 'synthetic' }, http).send(
      '100000000001',
      '12025550123',
      { type: 'text', body: 'Test' },
    ),
  ).resolves.toBe('wamid.synthetic');
});
