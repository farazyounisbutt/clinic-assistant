import { describe, expect, it, vi } from 'vitest';
import {
  parseWebhook,
  verifySignature,
  webhook,
} from '../../src/adapters/whatsapp/webhook.js';
import { MetaClient } from '../../src/adapters/whatsapp/client.js';

const phone = '100000000001';
const sender = '12025550123';
export function payload(messages: unknown[] = [], statuses: unknown[] = []) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: { metadata: { phone_number_id: phone }, messages, statuses },
          },
        ],
      },
    ],
  };
}
export async function signed(body: string, secret = 'synthetic-secret') {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return (
    'sha256=' +
    Array.from(
      new Uint8Array(
        await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)),
      ),
      (b) => b.toString(16).padStart(2, '0'),
    ).join('')
  );
}
const config = {
  META_APP_SECRET: 'synthetic-secret',
  WHATSAPP_VERIFY_TOKEN: 'synthetic-verify',
  WHATSAPP_PHONE_CLINICS: JSON.stringify({ [phone]: 'demo_clinic' }),
};

describe('WhatsApp authenticated boundary', () => {
  it('verifies the challenge and rejects missing/wrong tokens', async () => {
    const receive = vi.fn();
    for (const token of ['wrong', ''])
      expect(
        (
          await webhook(
            new Request(
              `https://example.test/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=123`,
            ),
            config,
            receive,
          )
        ).status,
      ).toBe(403);
    const response = await webhook(
      new Request(
        'https://example.test/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=synthetic-verify&hub.challenge=123',
      ),
      config,
      receive,
    );
    expect(await response.text()).toBe('123');
    expect(receive).not.toHaveBeenCalled();
  });
  it('checks HMAC against the exact bytes', async () => {
    const body = '{"text":"synthetic"}';
    const signature = await signed(body);
    expect(
      await verifySignature(
        new TextEncoder().encode(body),
        signature,
        config.META_APP_SECRET,
      ),
    ).toBe(true);
    expect(
      await verifySignature(
        new TextEncoder().encode(body + ' '),
        signature,
        config.META_APP_SECRET,
      ),
    ).toBe(false);
    expect(await verifySignature(new Uint8Array(), 'invalid', '')).toBe(false);
  });
  it('parses text, buttons and lists separately from statuses, discarding profile/media fields', () => {
    const events = parseWebhook(
      payload(
        [
          {
            id: 'wamid.1',
            from: sender,
            timestamp: '1900000000',
            type: 'text',
            text: { body: 'hello' },
            profile: { name: 'discard' },
          },
          {
            id: 'wamid.2',
            from: sender,
            timestamp: '1900000000',
            type: 'interactive',
            interactive: {
              type: 'button_reply',
              button_reply: { id: '1:book', title: 'discard' },
            },
          },
          {
            id: 'wamid.3',
            from: sender,
            timestamp: '1900000000',
            type: 'interactive',
            interactive: {
              type: 'list_reply',
              list_reply: { id: '2:date:2030-09-16' },
            },
          },
          {
            id: 'wamid.4',
            from: sender,
            timestamp: '1900000000',
            type: 'image',
            image: { id: 'discard' },
          },
        ],
        [
          {
            id: 'wamid.out',
            recipient_id: sender,
            timestamp: '1900000000',
            status: 'read',
          },
        ],
      ),
    );
    expect(events[0]!.messages.map((m) => m.input)).toEqual([
      { type: 'text', value: 'hello' },
      { type: 'action', value: '1:book' },
      { type: 'action', value: '2:date:2030-09-16' },
      { type: 'unsupported', value: '' },
    ]);
    expect(events[0]!.statuses[0]!.status).toBe('read');
    expect(JSON.stringify(events)).not.toContain('discard');
  });
  it('only acknowledges after durable enqueue, rejects bad auth/unknown routing/malformed JSON/storage failure', async () => {
    const body = JSON.stringify(
      payload([
        {
          id: 'wamid.1',
          from: sender,
          timestamp: '1900000000',
          type: 'text',
          text: { body: 'hi' },
        },
      ]),
    );
    const request = async (raw = body) =>
      new Request('https://example.test/webhooks/whatsapp', {
        method: 'POST',
        body: raw,
        headers: { 'x-hub-signature-256': await signed(raw) },
      });
    const receive = vi.fn().mockResolvedValue(undefined);
    expect((await webhook(await request(), config, receive)).status).toBe(200);
    expect(receive).toHaveBeenCalledWith(
      'demo_clinic',
      expect.objectContaining({ phoneNumberId: phone }),
    );
    expect(
      (
        await webhook(
          await request(),
          { ...config, WHATSAPP_PHONE_CLINICS: '{}' },
          receive,
        )
      ).status,
    ).toBe(400);
    expect((await webhook(await request('{'), config, receive)).status).toBe(
      400,
    );
    expect(
      (
        await webhook(
          new Request('https://example.test/webhooks/whatsapp', {
            method: 'POST',
            body,
          }),
          config,
          receive,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await webhook(
          await request(),
          config,
          vi.fn().mockRejectedValue(new Error('private')),
        )
      ).status,
    ).toBe(503);
    let release!: () => void;
    let settled = false;
    const pending = webhook(
      await request(),
      config,
      () =>
        new Promise<void>((r) => {
          release = r;
        }),
    ).then((r) => {
      settled = true;
      return r;
    });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect(settled).toBe(false);
    release();
    expect((await pending).status).toBe(200);
  });
});

describe('Meta outbound client', () => {
  it('uses the configured version and supports text/buttons/lists', async () => {
    const http = vi
      .fn()
      .mockImplementation(async () =>
        Response.json({ messages: [{ id: 'wamid.out' }] }),
      );
    const client = new MetaClient(
      { META_ACCESS_TOKEN: 'synthetic-token', WHATSAPP_GRAPH_VERSION: 'v25.0' },
      http,
    );
    for (const message of [
      { type: 'text' as const, body: 'Hello' },
      {
        type: 'buttons' as const,
        body: 'Choose',
        choices: [{ id: '1:book', title: 'Book Appointment' }],
      },
      {
        type: 'list' as const,
        body: 'Choose',
        choices: [{ id: '2:date', title: '2030-09-16' }],
      },
    ])
      expect(await client.send(phone, sender, message)).toBe('wamid.out');
    expect(http.mock.calls[0]![0]).toBe(
      `https://graph.facebook.com/v25.0/${phone}/messages`,
    );
    expect(
      JSON.parse(http.mock.calls[1]![1].body).interactive.action.buttons,
    ).toHaveLength(1);
  });
  it.each([
    [400, 'Rejected'],
    [401, 'Authentication'],
    [403, 'Authentication'],
    [429, 'RateLimited'],
    [500, 'Uncertain'],
  ])(
    'classifies HTTP %s without leaking its body',
    async (status, category) => {
      const client = new MetaClient(
        { META_ACCESS_TOKEN: 'synthetic' },
        vi
          .fn()
          .mockResolvedValue(
            new Response('private', { status: Number(status) }),
          ),
      );
      await expect(
        client.send(phone, sender, { type: 'text', body: 'Hi' }),
      ).rejects.toMatchObject({
        category,
        message: `Meta messaging: ${category}`,
      });
    },
  );
  it('classifies network failure and missing configuration', async () => {
    await expect(
      new MetaClient(
        { META_ACCESS_TOKEN: 'synthetic' },
        vi.fn().mockRejectedValue(new Error('private')),
      ).send(phone, sender, { type: 'text', body: 'Hi' }),
    ).rejects.toMatchObject({ category: 'Uncertain' });
    await expect(
      new MetaClient({}).send(phone, sender, { type: 'text', body: 'Hi' }),
    ).rejects.toMatchObject({ category: 'Configuration' });
  });
});

describe('malformed and bounded callbacks', () => {
  it.each([
    null,
    [],
    {},
    { object: 'wrong', entry: [] },
    { object: 'whatsapp_business_account', entry: 'wrong' },
    payload([
      {
        id: 'wamid.bad',
        from: sender,
        timestamp: 'NaN',
        type: 'text',
        text: { body: 'hi' },
      },
    ]),
    payload([
      {
        id: 'wamid.bad',
        from: 'not-a-number',
        timestamp: '1900000000',
        type: 'text',
        text: { body: 'hi' },
      },
    ]),
    payload([
      {
        id: 'wamid.bad',
        from: '1234567890123456',
        timestamp: '1900000000',
        type: 'text',
        text: { body: 'hi' },
      },
    ]),
    payload([
      {
        id: 'wamid.bad',
        from: sender,
        timestamp: '1900000000',
        type: 'text',
        text: { body: 1 },
      },
    ]),
    payload(
      Array.from({ length: 101 }, (_, i) => ({
        id: `wamid.${i}`,
        from: sender,
        timestamp: '1900000000',
        type: 'text',
        text: { body: 'hi' },
      })),
    ),
  ])('rejects malformed envelopes without processing', (value) => {
    expect(() => parseWebhook(value)).toThrow();
  });
  it('ignores unrelated change/status types and strips oversized text', () => {
    expect(
      parseWebhook({
        object: 'whatsapp_business_account',
        entry: [{ changes: [{ field: 'other' }] }],
      }),
    ).toEqual([]);
    expect(
      parseWebhook(
        payload(
          [
            {
              id: 'wamid.1',
              from: sender,
              timestamp: '1900000000',
              type: 'text',
              text: { body: 'x'.repeat(161) },
            },
          ],
          [{ status: 'unknown' }],
        ),
      )[0],
    ).toMatchObject({
      messages: [{ input: { type: 'unsupported', value: '' } }],
      statuses: [],
    });
  });
  it('bounds raw body size and fails closed for missing configuration/body or wrong methods', async () => {
    const receive = vi.fn();
    expect(
      (
        await webhook(
          new Request('https://example.test/webhooks/whatsapp', {
            method: 'POST',
            body: 'x'.repeat(262145),
          }),
          config,
          receive,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await webhook(
          new Request('https://example.test/webhooks/whatsapp', {
            method: 'POST',
          }),
          config,
          receive,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await webhook(
          new Request('https://example.test/webhooks/whatsapp', {
            method: 'POST',
          }),
          {},
          receive,
        )
      ).status,
    ).toBe(503);
    expect(
      (
        await webhook(
          new Request('https://example.test/webhooks/whatsapp', {
            method: 'PUT',
          }),
          config,
          receive,
        )
      ).status,
    ).toBe(405);
    expect(
      (
        await webhook(
          new Request('https://example.test/other'),
          config,
          receive,
        )
      ).status,
    ).toBe(404);
    expect(receive).not.toHaveBeenCalled();
  });
  it('validates every phone route before enqueuing any clinic and routes the same sender independently', async () => {
    const a = payload([
      {
        id: 'wamid.1',
        from: sender,
        timestamp: '1900000000',
        type: 'text',
        text: { body: 'hi' },
      },
    ]);
    const b = structuredClone(a.entry[0]!.changes[0]!);
    b.value.metadata.phone_number_id = '100000000002';
    a.entry[0]!.changes.push(b);
    const raw = JSON.stringify(a);
    const request = () =>
      signed(raw).then(
        (signature) =>
          new Request('https://example.test/webhooks/whatsapp', {
            method: 'POST',
            body: raw,
            headers: { 'x-hub-signature-256': signature },
          }),
      );
    const receive = vi.fn().mockResolvedValue(undefined);
    expect((await webhook(await request(), config, receive)).status).toBe(400);
    expect(receive).not.toHaveBeenCalled();
    expect(
      (
        await webhook(
          await request(),
          {
            ...config,
            WHATSAPP_PHONE_CLINICS: JSON.stringify({
              [phone]: 'demo_clinic',
              '100000000002': 'another_demo_clinic',
            }),
          },
          receive,
        )
      ).status,
    ).toBe(200);
    expect(receive.mock.calls.map((c) => c[0])).toEqual([
      'demo_clinic',
      'another_demo_clinic',
    ]);
  });
});

describe('outbound validation and timeout', () => {
  it('aborts timed-out HTTP and classifies malformed success without retrying', async () => {
    const http = vi.fn<typeof fetch>().mockImplementation(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () =>
            reject(new Error('synthetic timeout')),
          );
        }),
    );
    await expect(
      new MetaClient({ META_ACCESS_TOKEN: 'synthetic' }, http, 1).send(
        phone,
        sender,
        { type: 'text', body: 'Hello' },
      ),
    ).rejects.toMatchObject({ category: 'Uncertain' });
    expect(http).toHaveBeenCalledTimes(1);
    const malformed = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json({ messages: [] }));
    await expect(
      new MetaClient({ META_ACCESS_TOKEN: 'synthetic' }, malformed).send(
        phone,
        sender,
        { type: 'text', body: 'Hello' },
      ),
    ).rejects.toMatchObject({ category: 'Uncertain' });
  });
  it('rejects invalid payload/configuration before any HTTP request', async () => {
    const http = vi.fn<typeof fetch>();
    const client = new MetaClient({ META_ACCESS_TOKEN: 'synthetic' }, http);
    await expect(
      client.send(phone, sender, { type: 'text', body: '' }),
    ).rejects.toMatchObject({ category: 'Rejected' });
    await expect(
      client.send(phone, sender, {
        type: 'buttons',
        body: 'Pick',
        choices: [],
      }),
    ).rejects.toMatchObject({ category: 'Rejected' });
    await expect(
      client.send(phone, sender, {
        type: 'buttons',
        body: 'Pick',
        choices: [{ id: 'a', title: 'a'.repeat(21) }],
      }),
    ).rejects.toMatchObject({ category: 'Rejected' });
    await expect(
      client.send(phone, sender, {
        type: 'list',
        body: 'Pick',
        choices: [
          { id: 'a', title: 'A' },
          { id: 'a', title: 'B' },
        ],
      }),
    ).rejects.toMatchObject({ category: 'Rejected' });
    await expect(
      new MetaClient(
        { META_ACCESS_TOKEN: 'synthetic', WHATSAPP_GRAPH_VERSION: '../../bad' },
        http,
      ).send(phone, sender, { type: 'text', body: 'Hi' }),
    ).rejects.toMatchObject({ category: 'Configuration' });
    expect(http).not.toHaveBeenCalled();
  });
});

it('defaults to Graph v26.0 while preserving an explicit version override', async () => {
  const http = vi
    .fn<typeof fetch>()
    .mockImplementation(async () =>
      Response.json({ messages: [{ id: 'wamid.synthetic' }] }),
    );
  await new MetaClient({ META_ACCESS_TOKEN: 'synthetic-token' }, http).send(
    phone,
    sender,
    { type: 'text', body: 'Test' },
  );
  expect(http.mock.calls[0]![0]).toBe(
    `https://graph.facebook.com/v26.0/${phone}/messages`,
  );
  await new MetaClient(
    { META_ACCESS_TOKEN: 'synthetic-token', WHATSAPP_GRAPH_VERSION: 'v25.0' },
    http,
  ).send(phone, sender, { type: 'text', body: 'Test' });
  expect(http.mock.calls[1]![0]).toBe(
    `https://graph.facebook.com/v25.0/${phone}/messages`,
  );
});
