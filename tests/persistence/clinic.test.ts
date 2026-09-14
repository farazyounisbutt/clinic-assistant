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
import { AppointmentService } from '../../src/appointments/service.js';
import {
  clinic as example,
  hours as exampleHours,
} from '../support/fixtures.js';
import type {
  ClinicRecordProjection,
  ClinicProjectionSnapshot,
} from '../../src/ports/projection.js';

afterEach(async () => {
  vi.useRealTimers();
  await reset();
});
const bindings = env as WorkerEnv;
const date = '2030-09-16'; // Synthetic Monday; injected clock, no real clinic hours.
const initialTime = '2030-09-16T03:00:00.000Z';
const actor = { id: 'clerk-example', role: 'Clerk' as const };
const clinicId = 'demo_clinic';
function stub(id = clinicId) {
  return bindings.CLINICS.getByName(id);
}

async function scenario(
  run: (
    repo: SqliteClinicRepository,
    service: AppointmentService,
    clock: { now(): Date; advance(): void },
  ) => Promise<void>,
) {
  await runInDurableObject(stub(), async (_instance, state) => {
    let instant = new Date(initialTime);
    const clock = {
      now: () => instant,
      advance: () => {
        instant = new Date(instant.getTime() + 600_000);
      },
    };
    const repo = new SqliteClinicRepository(state.storage, clinicId, clock);
    await repo.configure(
      { clinic: example, workingHours: [exampleHours], blockedSlots: [] },
      actor.id,
    );
    let id = 0;
    const service = new AppointmentService(repo.asActor(actor.id), clock, {
      next: () => `appt-${++id}`,
    });
    await run(repo, service, clock);
  });
}
const booking = {
  clinicId,
  patientId: 'patient-example',
  patientName: 'Example Patient',
  whatsappNumber: '+12025550123',
  appointmentDate: date,
  startTime: '09:00',
  source: 'WhatsApp' as const,
  createdBy: actor.id,
};

describe('SQLite-backed clinic state', () => {
  it('persists a booking, patient, audit event, and outbox work together', async () => {
    await scenario(async (repo, service) => {
      const booked = await service.book(booking);
      expect(await repo.findById(clinicId, booked.appointmentId)).toEqual(
        booked,
      );
      expect(repo.exportRecords().patients).toHaveLength(1);
      expect(repo.exportRecords().activity).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: 'AppointmentCreated',
            actorId: actor.id,
            appointmentId: booked.appointmentId,
          }),
        ]),
      );
      expect(repo.projectionStatus().pending).toBe(2);
    });
  });
  it('persists cancellation and permits rebooking the freed grid slot', async () => {
    await scenario(async (repo, service) => {
      const booked = await service.book(booking);
      await service.transition({
        clinicId,
        appointmentId: booked.appointmentId,
        to: 'Cancelled',
        actor,
      });
      expect(await repo.findById(clinicId, booked.appointmentId)).toMatchObject(
        { status: 'Cancelled', cancelledAt: initialTime },
      );
      expect(await service.book(booking)).toMatchObject({
        status: 'Scheduled',
      });
    });
  });
  it('persists walk-in check-in and early completion', async () => {
    await scenario(async (repo, service, clock) => {
      const booked = await service.book({ ...booking, source: 'WalkIn' });
      await service.transition({
        clinicId,
        appointmentId: booked.appointmentId,
        to: 'CheckedIn',
        actor,
      });
      clock.advance();
      await service.transition({
        clinicId,
        appointmentId: booked.appointmentId,
        to: 'Completed',
        actor,
      });
      expect(await repo.findById(clinicId, booked.appointmentId)).toMatchObject(
        {
          source: 'WalkIn',
          status: 'Completed',
          checkedInAt: initialTime,
          completedAt: clock.now().toISOString(),
        },
      );
    });
  });
  it('retains explicit NoShow and rejects invalid transitions without audit/outbox writes', async () => {
    await scenario(async (repo, service) => {
      const booked = await service.book(booking);
      await service.transition({
        clinicId,
        appointmentId: booked.appointmentId,
        to: 'NoShow',
        actor,
      });
      const before = repo.projectionStatus();
      await expect(
        service.transition({
          clinicId,
          appointmentId: booked.appointmentId,
          to: 'CheckedIn',
          actor,
        }),
      ).rejects.toMatchObject({ code: 'InvalidAppointmentTransition' });
      expect(repo.projectionStatus()).toEqual(before);
      expect(await repo.findById(clinicId, booked.appointmentId)).toMatchObject(
        { status: 'NoShow' },
      );
    });
  });
  it('persists working periods, breaks, and blocked intervals', async () => {
    await scenario(async (repo, service) => {
      await repo.configure(
        {
          clinic: example,
          workingHours: [
            {
              ...exampleHours,
              breaks: [{ startTime: '09:15', endTime: '09:25' }],
            },
          ],
          blockedSlots: [
            {
              id: 'block-example',
              clinicId,
              date,
              startTime: '09:40',
              endTime: '10:00',
              reason: 'Unavailable',
            },
          ],
        },
        actor.id,
      );
      expect(await service.availability(clinicId, date)).toEqual([]);
      await expect(service.book(booking)).rejects.toMatchObject({
        code: 'SlotOverlapsBreak',
      });
      await expect(
        service.book({ ...booking, startTime: '09:40' }),
      ).rejects.toMatchObject({ code: 'SlotBlocked' });
      expect(repo.exportRecords().blockedSlots).toHaveLength(1);
    });
  });
  it('atomically preserves linked reschedule history', async () => {
    await scenario(async (repo, service) => {
      const original = await service.book(booking);
      const next = await service.reschedule({
        clinicId,
        appointmentId: original.appointmentId,
        appointmentDate: date,
        startTime: '09:20',
        createdBy: actor.id,
      });
      expect(
        await repo.findById(clinicId, original.appointmentId),
      ).toMatchObject({
        status: 'Rescheduled',
        rescheduledTo: next.appointmentId,
        startTime: '09:00',
      });
      expect(next.rescheduledFrom).toBe(original.appointmentId);
      expect(repo.exportRecords().activity.map((a) => a.action)).toContain(
        'AppointmentRescheduled',
      );
    });
  });
  it('failed reschedule leaves original and outbox unchanged', async () => {
    await scenario(async (repo, service) => {
      const a = await service.book(booking);
      await service.book({ ...booking, startTime: '09:20' });
      const status = repo.projectionStatus();
      await expect(
        service.reschedule({
          clinicId,
          appointmentId: a.appointmentId,
          appointmentDate: date,
          startTime: '09:20',
          createdBy: actor.id,
        }),
      ).rejects.toMatchObject({ code: 'SlotConflict' });
      expect(await repo.findById(clinicId, a.appointmentId)).toEqual(a);
      expect(repo.projectionStatus()).toEqual(status);
    });
  });
  it('serializes concurrent conflicting reservations', async () => {
    await scenario(async (repo, service) => {
      const results = await Promise.allSettled([
        service.book(booking),
        service.book(booking),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toEqual([
        expect.objectContaining({
          reason: expect.objectContaining({ code: 'SlotConflict' }),
        }),
      ]);
      expect(await repo.listByDate(clinicId, date)).toHaveLength(1);
    });
  });
  it('survives repository re-instantiation over real Durable Object SQLite', async () => {
    await runInDurableObject(stub(), async (_instance, state) => {
      const clock = { now: () => new Date(initialTime) };
      const first = new SqliteClinicRepository(state.storage, clinicId, clock);
      await first.configure(
        { clinic: example, workingHours: [exampleHours], blockedSlots: [] },
        actor.id,
      );
      const service = new AppointmentService(first.asActor(actor.id), clock, {
        next: () => 'persistent-id',
      });
      const record = await service.book(booking);
      const second = new SqliteClinicRepository(state.storage, clinicId, clock);
      expect(await second.findById(clinicId, 'persistent-id')).toEqual(record);
      expect(second.projectionStatus().pending).toBe(2);
      expect(state.storage.sql.databaseSize).toBeGreaterThan(0);
    });
  });
  it.each(['inactive', 'suspended'] as const)(
    'enforces %s policy while allowing existing records and exports',
    async (subscriptionStatus) => {
      await scenario(async (repo, service) => {
        const record = await service.book(booking);
        await repo.configure(
          {
            clinic: { ...example, subscriptionStatus },
            workingHours: [exampleHours],
            blockedSlots: [],
          },
          actor.id,
        );
        await expect(
          service.book({ ...booking, source: 'WalkIn', startTime: '09:20' }),
        ).rejects.toMatchObject({ code: 'SubscriptionInactive' });
        await expect(
          service.reschedule({
            clinicId,
            appointmentId: record.appointmentId,
            appointmentDate: date,
            startTime: '09:20',
            createdBy: actor.id,
          }),
        ).rejects.toMatchObject({ code: 'SubscriptionInactive' });
        await service.transition({
          clinicId,
          appointmentId: record.appointmentId,
          to: 'CheckedIn',
          actor,
        });
        await service.transition({
          clinicId,
          appointmentId: record.appointmentId,
          to: 'Completed',
          actor,
        });
        expect(await service.listAppointments(clinicId, date)).toHaveLength(1);
        expect(repo.exportRecords().appointments).toHaveLength(1);
      });
    },
  );
});

class IdempotentProjection implements ClinicRecordProjection {
  readonly records = new Map<string, unknown>();
  revision = 0;
  failAfterApply = false;
  async applySnapshot(snapshot: ClinicProjectionSnapshot): Promise<void> {
    if (snapshot.revision > this.revision) {
      this.records.clear();
      for (const [sheet, rows] of Object.entries(snapshot.sheets))
        for (const row of rows) this.records.set(`${sheet}:${row.key}`, row);
      this.revision = snapshot.revision;
    }
    if (this.failAfterApply) {
      this.failAfterApply = false;
      throw new Error('Acknowledgement lost');
    }
  }
}

describe('durable projection outbox', () => {
  it('keeps bookings reserved through a projection outage', async () => {
    await scenario(async (repo, service, clock) => {
      const record = await service.book(booking);
      await repo.flushProjection({
        applySnapshot: async () => {
          throw new Error('Unavailable');
        },
      });
      expect(repo.projectionStatus()).toMatchObject({ pending: 2, failed: 1 });
      expect(await repo.findById(clinicId, record.appointmentId)).toEqual(
        record,
      );
      await expect(service.book(booking)).rejects.toMatchObject({
        code: 'SlotConflict',
      });
      clock.advance();
      await repo.flushProjection(new IdempotentProjection());
      expect(repo.projectionStatus().pending).toBe(0);
    });
  });
  it('retries an acknowledged-lost snapshot idempotently without duplicate logical rows', async () => {
    await scenario(async (repo, service, clock) => {
      const receiver = new IdempotentProjection();
      await repo.flushProjection(receiver);
      await service.book(booking);
      receiver.failAfterApply = true;
      await repo.flushProjection(receiver);
      const keys = [...receiver.records.keys()];
      expect(keys.filter((k) => k.startsWith('Appointments:'))).toHaveLength(1);
      clock.advance();
      await repo.flushProjection(receiver);
      expect([...receiver.records.keys()]).toEqual(keys);
      expect(repo.projectionStatus()).toMatchObject({
        pending: 0,
        failed: 0,
        lastDeliveredRevision: 2,
      });
    });
  });
});

describe('coordination contract and runtime boundary', () => {
  it('rolls back appointment, patient, audit, revision, and outbox on an actual SQL failure', async () => {
    await runInDurableObject(stub(), async (_instance, state) => {
      const clock = { now: () => new Date(initialTime) };
      const repo = new SqliteClinicRepository(state.storage, clinicId, clock);
      await repo.configure(
        { clinic: example, workingHours: [exampleHours], blockedSlots: [] },
        actor.id,
      );
      const before = repo.exportRecords();
      await state.storage.deleteAlarm();
      const status = repo.projectionStatus();
      state.storage.sql.exec(
        "CREATE TRIGGER fail_outbox BEFORE INSERT ON projection_outbox BEGIN SELECT RAISE(ABORT, 'Injected storage failure'); END",
      );
      const service = new AppointmentService(repo.asActor(actor.id), clock, {
        next: () => 'rollback-id',
      });
      await expect(service.book(booking)).rejects.toThrow(
        'Injected storage failure',
      );
      expect(repo.exportRecords()).toEqual(before);
      expect(repo.projectionStatus()).toEqual(status);
      expect(await state.storage.getAlarm()).toBeNull();
      state.storage.sql.exec('DROP TRIGGER fail_outbox');
      expect(await service.book(booking)).toMatchObject({
        appointmentId: 'rollback-id',
      });
    });
  });
  it('rolls back both sides of a reschedule after staging succeeds but SQLite fails', async () => {
    await runInDurableObject(stub(), async (_instance, state) => {
      const clock = { now: () => new Date(initialTime) };
      const repo = new SqliteClinicRepository(state.storage, clinicId, clock);
      await repo.configure(
        { clinic: example, workingHours: [exampleHours], blockedSlots: [] },
        actor.id,
      );
      let id = 0;
      const service = new AppointmentService(repo.asActor(actor.id), clock, {
        next: () => `a-${++id}`,
      });
      const original = await service.book(booking);
      const before = repo.exportRecords();
      state.storage.sql.exec(
        "CREATE TRIGGER fail_audit BEFORE INSERT ON activity_log BEGIN SELECT RAISE(ABORT, 'Audit unavailable'); END",
      );
      await expect(
        service.reschedule({
          clinicId,
          appointmentId: original.appointmentId,
          appointmentDate: date,
          startTime: '09:20',
          createdBy: actor.id,
        }),
      ).rejects.toThrow('Audit unavailable');
      expect(repo.exportRecords()).toEqual(before);
      expect(repo.projectionStatus().pending).toBe(2);
    });
  });
  it('enforces final-state overlap even for a writer that bypasses the service', async () => {
    await scenario(async (repo, service) => {
      const first = await service.book(booking);
      await expect(
        repo.runExclusive(clinicId, async (unit) => {
          await unit.insert({ ...first, appointmentId: 'overlap' });
        }),
      ).rejects.toMatchObject({ code: 'SlotConflict' });
      expect(await repo.findById(clinicId, 'overlap')).toBeNull();
      await expect(
        repo.runExclusive('other_clinic', async () => undefined),
      ).rejects.toMatchObject({ code: 'InvalidInput' });
      await expect(
        repo.findById('other_clinic', first.appointmentId),
      ).rejects.toMatchObject({ code: 'InvalidInput' });
      await expect(
        repo.runExclusive(clinicId, async (unit) => unit.insert(first)),
      ).rejects.toMatchObject({ code: 'InvalidInput' });
      await expect(
        repo.runExclusive(clinicId, async (unit) =>
          unit.replace({ ...first, appointmentId: 'missing' }),
        ),
      ).rejects.toMatchObject({ code: 'AppointmentNotFound' });
      let retained:
        Parameters<Parameters<typeof repo.runExclusive>[1]>[0] | undefined;
      await repo.runExclusive(clinicId, async (unit) => {
        retained = unit;
        expect(await unit.findAppointment('missing')).toBeNull();
      });
      await expect(retained!.listWorkingHours()).rejects.toMatchObject({
        code: 'InvalidInput',
      });
    });
  });
  it('shares serialization across repository instances and rolls back a callback rejection', async () => {
    await runInDurableObject(stub(), async (_instance, state) => {
      const clock = { now: () => new Date(initialTime) };
      const one = new SqliteClinicRepository(state.storage, clinicId, clock);
      const two = new SqliteClinicRepository(state.storage, clinicId, clock);
      await one.configure(
        { clinic: example, workingHours: [exampleHours], blockedSlots: [] },
        actor.id,
      );
      const results = await Promise.allSettled(
        [one, two].map((repo, i) =>
          new AppointmentService(repo, clock, {
            next: () => `shared-${i}`,
          }).book(booking),
        ),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const record = (await one.listByDate(clinicId, date))[0]!;
      await expect(
        two.runExclusive(clinicId, async (unit) => {
          await unit.replace({ ...record, status: 'Cancelled' });
          throw new Error('Callback failed');
        }),
      ).rejects.toThrow('Callback failed');
      expect(await two.findById(clinicId, record.appointmentId)).toEqual(
        record,
      );
      expect(
        () => new SqliteClinicRepository(state.storage, 'other_clinic', clock),
      ).toThrow('Incompatible clinic storage');
    });
  });
  it('does not hold the booking mutex while projection is awaiting an external response', async () => {
    await scenario(async (repo, service) => {
      let release!: () => void;
      let started!: () => void;
      const waiting = new Promise<void>((r) => {
        release = r;
      });
      const ready = new Promise<void>((r) => {
        started = r;
      });
      const drain = repo.flushProjection({
        applySnapshot: async () => {
          started();
          await waiting;
        },
      });
      await ready;
      const booked = await service.book(booking);
      expect(booked.status).toBe('Scheduled');
      release();
      await drain;
      expect(repo.projectionStatus().pending).toBe(0);
    });
  });
  it('routes each clinic to one named object and allows identical slots in distinct clinics', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(initialTime));
    const ids = [clinicId, 'second_demo_clinic'];
    for (const id of ids) {
      expect(
        await stub(id).configure(
          {
            clinic: { ...example, clinicId: id },
            workingHours: [{ ...exampleHours, clinicId: id }],
            blockedSlots: [],
          },
          actor.id,
        ),
      ).toEqual({ ok: true, value: undefined });
    }
    const results = await Promise.all(
      ids.map((id) => stub(id).book({ ...booking, clinicId: id })),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    expect(await stub().book({ ...booking, clinicId: ids[1]! })).toMatchObject({
      ok: false,
      error: { code: 'InvalidInput' },
    });
    expect(await stub().appointments(clinicId, date)).toMatchObject({
      ok: true,
      value: [expect.objectContaining({ clinicId })],
    });
    expect(await stub(ids[1]!).appointments(ids[1]!, date)).toMatchObject({
      ok: true,
      value: [expect.objectContaining({ clinicId: ids[1] })],
    });
    expect(await stub().availability(clinicId, date)).toMatchObject({
      ok: true,
      value: [
        { startTime: '09:20', endTime: '09:40' },
        { startTime: '09:40', endTime: '10:00' },
      ],
    });
  });
  it('recovers actual object state after eviction, and alarm leaves unconfigured projection pending', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(initialTime));
    await stub().configure(
      { clinic: example, workingHours: [exampleHours], blockedSlots: [] },
      actor.id,
    );
    const booked = await stub().book(booking);
    expect(booked.ok).toBe(true);
    await evictDurableObject(stub());
    expect(await stub().exportRecords(clinicId)).toMatchObject({
      ok: true,
      value: {
        appointments: [expect.objectContaining({ startTime: '09:00' })],
      },
    });
    vi.setSystemTime(new Date('2030-09-16T04:00:00.000Z'));
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    expect(await stub().projectionStatus(clinicId)).toMatchObject({
      ok: true,
      value: { pending: 2, failed: 1 },
    });
    if (!booked.ok) throw new Error('Expected booking');
    const next = await stub().reschedule({
      clinicId,
      appointmentId: booked.value.appointmentId,
      appointmentDate: date,
      startTime: '09:20',
      createdBy: actor.id,
    });
    expect(next.ok).toBe(true);
    if (!next.ok) throw new Error('Expected reschedule');
    expect(
      await stub().transition({
        clinicId,
        appointmentId: next.value.appointmentId,
        to: 'Cancelled',
        actor,
      }),
    ).toMatchObject({ ok: true, value: { status: 'Cancelled' } });
  });
});

describe('projection recovery boundaries', () => {
  it('honors backoff and delivers at most 25 snapshots before continuing the backlog', async () => {
    await scenario(async (repo, _service, clock) => {
      for (let i = 0; i < 26; i++)
        await repo.configure(
          { clinic: example, workingHours: [exampleHours], blockedSlots: [] },
          actor.id,
        );
      let attempts = 0;
      await repo.flushProjection({
        applySnapshot: async () => {
          attempts++;
          throw new Error('Outage');
        },
      });
      await repo.flushProjection({
        applySnapshot: async () => {
          attempts++;
        },
      });
      expect(attempts).toBe(1);
      expect(repo.projectionStatus().pending).toBe(27);
      clock.advance();
      const receiver = new IdempotentProjection();
      await repo.flushProjection(receiver);
      expect(repo.projectionStatus().pending).toBe(2);
      await repo.flushProjection(receiver);
      expect(repo.projectionStatus()).toMatchObject({
        pending: 0,
        lastDeliveredRevision: 27,
      });
    });
  });
  it('projects config removals and preserves historical patient snapshots without auditing contacts', async () => {
    await scenario(async (repo, service, clock) => {
      const first = await service.book({
        ...booking,
        reason: 'Administrative example',
      });
      clock.advance();
      await service.book({
        ...booking,
        startTime: '09:40',
        patientName: 'Updated Example',
        whatsappNumber: '+12025550124',
      });
      await service.reschedule({
        clinicId,
        appointmentId: first.appointmentId,
        appointmentDate: date,
        startTime: '09:20',
        createdBy: actor.id,
      });
      const records = repo.exportRecords();
      expect(records.patients[0]).toMatchObject({
        name: 'Updated Example',
        createdAt: initialTime,
      });
      expect(
        records.appointments.find(
          (a) => a.appointmentId === first.appointmentId,
        )!.patientName,
      ).toBe('Example Patient');
      expect(JSON.stringify(records.activity)).not.toContain('1202555');
      expect(JSON.stringify(records.activity)).not.toContain('Example Patient');
      const receiver = new IdempotentProjection();
      await repo.flushProjection(receiver);
      expect(
        [...receiver.records.keys()].filter((k) =>
          k.startsWith('Working_Hours:'),
        ),
      ).toHaveLength(1);
      await repo.configure(
        { clinic: example, workingHours: [], blockedSlots: [] },
        actor.id,
      );
      await repo.flushProjection(receiver);
      expect(
        [...receiver.records.keys()].filter((k) =>
          k.startsWith('Working_Hours:'),
        ),
      ).toEqual([]);
    });
  });
  it('masks unexpected storage errors at RPC and rejects unknown migration versions', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(initialTime));
    await stub().configure(
      { clinic: example, workingHours: [exampleHours], blockedSlots: [] },
      actor.id,
    );
    await runInDurableObject(stub(), async (_instance, state) => {
      state.storage.sql.exec(
        "CREATE TRIGGER fail_write BEFORE INSERT ON appointments BEGIN SELECT RAISE(ABORT, 'Private diagnostic'); END",
      );
    });
    expect(await stub().book(booking)).toEqual({
      ok: false,
      error: { code: 'StorageUnavailable', message: 'Clinic operation failed' },
    });
    await runInDurableObject(stub(), async (_instance, state) => {
      state.storage.sql.exec('UPDATE metadata SET schema_version=2');
      expect(
        () =>
          new SqliteClinicRepository(state.storage, clinicId, {
            now: () => new Date(initialTime),
          }),
      ).toThrow('Incompatible clinic storage');
    });
  });
});

it('allows only one of two concurrent RPC reservations of the same slot', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(initialTime));
  await stub().configure(
    { clinic: example, workingHours: [exampleHours], blockedSlots: [] },
    actor.id,
  );
  const results = await Promise.all([
    stub().book(booking),
    stub().book(booking),
  ]);
  expect(results.filter((r) => r.ok)).toHaveLength(1);
  expect(results.filter((r) => !r.ok)).toEqual([
    expect.objectContaining({
      error: expect.objectContaining({ code: 'SlotConflict' }),
    }),
  ]);
});
