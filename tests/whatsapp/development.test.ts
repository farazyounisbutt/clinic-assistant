import { env } from 'cloudflare:workers';
import { runInDurableObject, reset } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import development, {
  ClinicDurableObject,
  TEST_CLINIC,
} from '../../src/adapters/cloudflare/development.js';
import type { DevelopmentEnv } from '../../src/adapters/cloudflare/development.js';
import type { WorkerEnv } from '../../src/adapters/cloudflare/worker.js';
import { clinic, hours } from '../support/fixtures.js';
import production from '../../src/adapters/cloudflare/worker.js';
import { verifySignature } from '../../src/adapters/whatsapp/webhook.js';
const bindings = env as WorkerEnv;
const token = 'synthetic-development-operator-token';
const config = {
  ...bindings,
  DEVELOPMENT_MODE: 'true',
  DEVELOPMENT_ADMIN_TOKEN: token,
} as DevelopmentEnv;
const request = (path: string, body?: unknown) =>
  new Request(`https://example.test/__development/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});
it('fails closed outside development and requires a separate admin token', async () => {
  expect(
    (
      await development.fetch(request('inspect'), {
        ...config,
        DEVELOPMENT_MODE: 'false',
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await development.fetch(
        new Request('https://example.test/__development/inspect'),
        config,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await development.fetch(request('inspect'), {
        ...config,
        DEVELOPMENT_ADMIN_TOKEN: '',
      })
    ).status,
  ).toBe(403);
  expect((await production.fetch(request('inspect'), bindings)).status).toBe(
    404,
  );
  expect((await development.fetch(request('missing'), config)).status).toBe(
    405,
  );
});
it('scopes inspection and replay to the synthetic clinic and masks contacts', async () => {
  await runInDurableObject(
    bindings.CLINICS.getByName(TEST_CLINIC),
    async (_instance, state) => {
      const instance = new ClinicDurableObject(state, bindings);
      await instance.configure(
        {
          clinic: { ...clinic, clinicId: TEST_CLINIC },
          workingHours: [{ ...hours, clinicId: TEST_CLINIC }],
          blockedSlots: [],
        },
        'synthetic',
      );
      await instance.receiveWhatsApp(TEST_CLINIC, {
        phoneNumberId: '100000000001',
        messages: [
          {
            id: 'wamid.synthetic',
            sender: '12025550123',
            timestamp: Date.now(),
            input: { type: 'text', value: 'Hi' },
          },
        ],
        statuses: [],
      });
      const result = await instance.inspectDevelopment();
      expect(JSON.stringify(result)).not.toContain('12025550123');
      expect(result.inbox.total).toBe(1);
      expect((await instance.developmentReplay())!.messages[0]!.id).toBe(
        'wamid.synthetic',
      );
      expect(await instance.developmentReplay()).toBeNull();
      await state.storage.put('development-last-message', {
        batch: {},
        expiresAt: 0,
      });
      expect(await instance.developmentReplay()).toBeNull();
    },
  );
  await runInDurableObject(
    bindings.CLINICS.getByName('other'),
    async (_instance, state) => {
      await expect(
        new ClinicDurableObject(state, bindings).inspectDevelopment(),
      ).rejects.toThrow('Test clinic only');
    },
  );
});
it('routes only allowed development operations and signs replay through the normal boundary', async () => {
  const stub = {
    inspectDevelopment: vi.fn().mockResolvedValue({ clinicId: TEST_CLINIC }),
    configure: vi.fn().mockResolvedValue({ ok: true }),
    book: vi.fn().mockResolvedValue({ ok: true }),
    bootstrapProjection: vi.fn().mockResolvedValue({ ok: true }),
    drainProjection: vi.fn().mockResolvedValue({ ok: true }),
    developmentReplay: vi.fn().mockResolvedValue(null),
  };
  const local = {
    ...config,
    META_APP_SECRET: 'synthetic-secret',
    CLINICS: { getByName: () => stub },
  } as unknown as DevelopmentEnv;
  expect((await development.fetch(request('inspect'), local)).status).toBe(200);
  expect((await development.fetch(request('missing', {}), local)).status).toBe(
    404,
  );
  expect(
    (await development.fetch(request('configure', { clinic }), local)).status,
  ).toBe(400);
  expect(
    (
      await development.fetch(
        request('configure', {
          clinic: { ...clinic, clinicId: TEST_CLINIC },
          workingHours: [],
          blockedSlots: [],
        }),
        local,
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await development.fetch(
        request('compete', { date: '2030-09-16', time: '09:00' }),
        local,
      )
    ).status,
  ).toBe(200);
  expect(stub.book).toHaveBeenCalledWith(
    expect.objectContaining({
      clinicId: TEST_CLINIC,
      patientName: 'Synthetic Competitor',
    }),
  );
  expect(
    (await development.fetch(request('projection/bootstrap', {}), local))
      .status,
  ).toBe(200);
  expect(
    (await development.fetch(request('projection/drain', {}), local)).status,
  ).toBe(200);
  expect((await development.fetch(request('replay', {}), local)).status).toBe(
    409,
  );
  expect(
    (
      await development.fetch(request('replay', {}), {
        ...local,
        META_APP_SECRET: '',
      })
    ).status,
  ).toBe(503);
  const forward = vi
    .spyOn(production, 'fetch')
    .mockImplementation(async (req?: Request) => {
      expect(
        await verifySignature(
          new Uint8Array(await req!.arrayBuffer()),
          req!.headers.get('x-hub-signature-256'),
          'synthetic-secret',
        ),
      ).toBe(true);
      return new Response('OK');
    });
  for (const type of ['text', 'action', 'unsupported'] as const) {
    stub.developmentReplay.mockResolvedValueOnce({
      phoneNumberId: '100000000001',
      messages: [
        {
          id: 'wamid.synthetic',
          sender: '12025550123',
          timestamp: 1900000000000,
          input: { type, value: 'test' },
        },
      ],
      statuses: [],
    });
    expect((await development.fetch(request('replay', {}), local)).status).toBe(
      200,
    );
  }
  expect(forward).toHaveBeenCalledTimes(3);
  stub.inspectDevelopment.mockRejectedValue(new Error('private'));
  expect(
    await (await development.fetch(request('inspect'), local)).text(),
  ).toBe('Development operation failed');
});
