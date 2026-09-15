import { env } from 'cloudflare:workers';
import {
  runInDurableObject,
  reset,
  evictDurableObject,
  runDurableObjectAlarm,
} from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkerEnv } from '../../src/adapters/cloudflare/worker.js';
import { SqliteClinicRepository } from '../../src/adapters/cloudflare/repository.js';
import { ProjectionFailure } from '../../src/projection/errors.js';
import { AppointmentService } from '../../src/appointments/service.js';
import { GoogleSheetsProjection } from '../../src/adapters/sheets/projection.js';
import { GoogleSheetsClient } from '../../src/adapters/sheets/client.js';
import { configuredTarget } from '../../src/adapters/sheets/configuration.js';
import { FakeGoogleSheets } from '../sheets/fake-google.js';
import { clinic, hours } from '../support/fixtures.js';
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await reset();
});
const bindings = env as WorkerEnv;
const stub = () => bindings.CLINICS.getByName(clinic.clinicId);
const initial = Date.parse('2030-09-16T03:00:00Z');
async function setup(
  run: (
    repo: SqliteClinicRepository,
    clock: { now(): Date; advance(ms: number): void },
    service: AppointmentService,
  ) => Promise<void>,
) {
  await runInDurableObject(stub(), async (_instance, state) => {
    let ms = initial;
    const clock = {
      now: () => new Date(ms),
      advance: (by: number) => {
        ms += by;
      },
    };
    const repo = new SqliteClinicRepository(
      state.storage,
      clinic.clinicId,
      clock,
    );
    await repo.configure(
      { clinic, workingHours: [hours], blockedSlots: [] },
      'clerk-example',
    );
    const service = new AppointmentService(repo, clock, {
      next: () => 'synthetic-new',
    });
    await run(repo, clock, service);
  });
}
describe('durable Google delivery', () => {
  it('reports backlog, persists 429 retry, and drains real HTTP projections in order', async () => {
    await setup(async (repo, clock, service) => {
      await service.book({
        clinicId: clinic.clinicId,
        patientId: 'synthetic-patient',
        patientName: 'Example',
        whatsappNumber: '+12025550123',
        appointmentDate: '2030-09-16',
        startTime: '09:00',
        source: 'Clerk',
        createdBy: 'clerk-example',
      });
      const fake = new FakeGoogleSheets();
      fake.failStatus = 429;
      const projection = new GoogleSheetsProjection(
        { clinicId: clinic.clinicId, spreadsheetId: 'synthetic-target' },
        new GoogleSheetsClient(
          { getToken: async () => 'synthetic-token', invalidate: () => {} },
          fake.fetch,
        ),
      );
      await repo.flushProjection(projection);
      expect(repo.projectionStatus()).toMatchObject({
        pending: 2,
        oldestPendingAt: initial,
        failedAttemptCount: 1,
        nextAttemptAt: initial + 120_000,
        lastFailure: { category: 'RateLimited' },
        blocked: false,
      });
      expect(
        await repo.findById(clinic.clinicId, 'synthetic-new'),
      ).toMatchObject({ status: 'Scheduled' });
      fake.failStatus = 0;
      clock.advance(119_000);
      await repo.flushProjection(projection);
      expect(fake.writes).toBe(0);
      clock.advance(1000);
      await repo.flushProjection(projection);
      expect(fake.writes).toBe(2);
      expect(repo.projectionStatus()).toMatchObject({
        pending: 0,
        oldestPendingAt: null,
        failedAttemptCount: 1,
        lastDeliveredRevision: 2,
      });
    });
  });
  it('keeps permanent failures visible and uses a slow configuration retry', async () => {
    await setup(async (repo, clock) => {
      const apply = vi.fn(async () => {
        throw new ProjectionFailure('Schema');
      });
      await repo.flushProjection({ applySnapshot: apply });
      clock.advance(3_600_000);
      await repo.flushProjection({ applySnapshot: apply });
      expect(apply).toHaveBeenCalledTimes(1);
      expect(repo.projectionStatus()).toMatchObject({
        pending: 1,
        blocked: true,
        nextAttemptAt: initial + 86_400_000,
        lastFailure: {
          category: 'Schema',
          message: 'Spreadsheet structure does not match projection schema',
        },
      });
    });
  });
  it('retains retry diagnostics and alarm scheduling after actual DO eviction', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(initial));
    await stub().configure(
      { clinic, workingHours: [hours], blockedSlots: [] },
      'clerk-example',
    );
    await runInDurableObject(stub(), async (_instance, state) => {
      const repo = new SqliteClinicRepository(state.storage, clinic.clinicId, {
        now: () => new Date(initial),
      });
      await repo.flushProjection({
        applySnapshot: async () => {
          throw new ProjectionFailure('Transient');
        },
      });
    });
    await evictDurableObject(stub());
    const status = await stub().projectionStatus(clinic.clinicId);
    expect(status).toMatchObject({
      ok: true,
      value: { pending: 1, failedAttemptCount: 1 },
    });
    vi.setSystemTime(new Date(initial + 86_400_000));
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    expect(await stub().projectionStatus(clinic.clinicId)).toMatchObject({
      ok: true,
      value: { pending: 1, lastFailure: { category: 'Configuration' } },
    });
  });
});
describe('clinic projection target isolation', () => {
  it('resolves only the configured clinic and rejects duplicate target mappings', () => {
    expect(
      configuredTarget(
        {
          GOOGLE_SHEETS_TARGETS:
            '{"demo_clinic":"synthetic-one","second_clinic":"synthetic-two"}',
        },
        clinic.clinicId,
      ),
    ).toEqual({ clinicId: clinic.clinicId, spreadsheetId: 'synthetic-one' });
    expect(() =>
      configuredTarget(
        {
          GOOGLE_SHEETS_TARGETS:
            '{"demo_clinic":"synthetic-one","second_clinic":"synthetic-one"}',
        },
        clinic.clinicId,
      ),
    ).toThrow();
    expect(() =>
      configuredTarget(
        { GOOGLE_SHEETS_TARGETS: '{"second_clinic":"synthetic-two"}' },
        clinic.clinicId,
      ),
    ).toThrow();
  });
});

it('migrates Task 3 pending snapshots without losing records or retry counts', async () => {
  await runInDurableObject(stub(), async (_instance, state) => {
    const snapshot = {
      sheets: {
        Activity_Log: [
          { cells: ['1:1', 1, clinic.clinicId, '1:1', '2030-09-16T03:00:00Z'] },
        ],
      },
    };
    state.storage.sql.exec(
      'CREATE TABLE metadata(singleton INTEGER PRIMARY KEY,schema_version INTEGER,clinic_id TEXT,revision INTEGER,delivered_revision INTEGER)',
    );
    state.storage.sql.exec(
      'INSERT INTO metadata VALUES(1,1,?,1,0)',
      clinic.clinicId,
    );
    state.storage.sql.exec(
      'CREATE TABLE projection_outbox(revision INTEGER PRIMARY KEY,snapshot TEXT,attempts INTEGER,next_attempt_at INTEGER,last_error TEXT)',
    );
    state.storage.sql.exec(
      'INSERT INTO projection_outbox VALUES(1,?,3,?,?)',
      JSON.stringify(snapshot),
      initial + 30000,
      'ProjectionUnavailable',
    );
    const repo = new SqliteClinicRepository(state.storage, clinic.clinicId, {
      now: () => new Date(initial),
    });
    expect(repo.projectionStatus()).toMatchObject({
      pending: 1,
      failedAttemptCount: 3,
      oldestPendingAt: initial,
      nextAttemptAt: initial + 30000,
    });
    const again = new SqliteClinicRepository(state.storage, clinic.clinicId, {
      now: () => new Date(initial),
    });
    expect(again.projectionStatus()).toEqual(repo.projectionStatus());
  });
});

it('composes service-account auth and Sheets delivery through the DO alarm after restart', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(initial));
  const { ClinicDurableObject } =
    await import('../../src/adapters/cloudflare/worker.js');
  const pair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const der = new Uint8Array(
    (await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer,
  );
  const privateKey = [
    '-----BEGIN PRIVATE KEY-----',
    btoa(String.fromCharCode(...der)),
    '-----END PRIVATE KEY-----',
  ].join('\n');
  const configured: WorkerEnv = {
    CLINICS: bindings.CLINICS,
    GOOGLE_SERVICE_ACCOUNT_EMAIL: 'service@example.invalid',
    GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: privateKey,
    GOOGLE_SHEETS_TARGETS: '{"demo_clinic":"synthetic-target"}',
  };
  const fake = new FakeGoogleSheets(clinic.clinicId, false);
  let tokens = 0;
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (url === 'https://oauth2.googleapis.com/token') {
      tokens++;
      return Response.json({
        access_token: 'synthetic-token',
        expires_in: 3600,
        token_type: 'Bearer',
      });
    }
    return fake.fetch(url, init);
  });
  await runInDurableObject(stub(), async (_instance, state) => {
    const first = new ClinicDurableObject(state, configured);
    expect(await first.bootstrapProjection(clinic.clinicId)).toMatchObject({
      ok: true,
    });
    expect(await first.validateProjection(clinic.clinicId)).toMatchObject({
      ok: true,
    });
    fake.failStatus = 503;
    expect(
      await first.configure(
        { clinic, workingHours: [hours], blockedSlots: [] },
        'clerk-example',
      ),
    ).toMatchObject({ ok: true });
    await first.drainProjection(clinic.clinicId);
    expect(
      await first.book({
        clinicId: clinic.clinicId,
        patientId: 'synthetic-patient',
        patientName: 'Example',
        whatsappNumber: '+12025550123',
        appointmentDate: '2030-09-16',
        startTime: '09:00',
        source: 'Clerk',
        createdBy: 'clerk-example',
      }),
    ).toMatchObject({ ok: true });
    await first.drainProjection(clinic.clinicId);
    fake.failStatus = 0;
    vi.setSystemTime(new Date(initial + 121_000));
    const restarted = new ClinicDurableObject(state, configured);
    await restarted.alarm();
    expect(await restarted.projectionStatus(clinic.clinicId)).toMatchObject({
      ok: true,
      value: { pending: 0, lastDeliveredRevision: 2 },
    });
    expect(fake.rows('Appointments')).toHaveLength(1);
    expect(tokens).toBe(2);
    expect(await restarted.bootstrapProjection('other_clinic')).toMatchObject({
      ok: false,
      error: { code: 'InvalidInput' },
    });
  });
});
