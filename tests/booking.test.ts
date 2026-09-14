import { describe, expect, it } from 'vitest';
import { AppointmentService } from '../src/appointments/service.js';
import { DomainError } from '../src/shared/errors.js';
import { InMemoryAppointmentStore } from './support/in-memory-store.js';
import { appointment, clinic, date, hours, now } from './support/fixtures.js';

const request = {
  clinicId: clinic.clinicId,
  patientId: 'patient-example',
  patientName: 'Example Patient',
  whatsappNumber: '+12025550123',
  appointmentDate: date,
  startTime: '09:00',
  source: 'WhatsApp' as const,
  createdBy: 'clerk-example',
};
const actor = { id: 'clerk-example', role: 'Clerk' as const };
function setup(seed = [appointment()], workingHours = [hours]) {
  const store = new InMemoryAppointmentStore({
    clinics: [clinic],
    workingHours,
    appointments: seed,
  });
  let tick = now;
  let id = 0;
  const service = new AppointmentService(
    store,
    { now: () => tick },
    { next: () => `new-${++id}` },
  );
  return {
    store,
    service,
    setTime: (value: string) => {
      tick = new Date(value);
    },
  };
}

describe('booking operations', () => {
  it('creates a scheduled appointment with generated duration and clean metadata', async () => {
    const { service, store } = setup([]);
    const result = await service.book(request);
    expect(result).toMatchObject({
      appointmentId: 'new-1',
      startTime: '09:00',
      endTime: '09:20',
      status: 'Scheduled',
      bookedAt: now.toISOString(),
      checkedInAt: null,
      completedAt: null,
      cancelledAt: null,
      rescheduledFrom: null,
      rescheduledTo: null,
    });
    expect(await store.findById(clinic.clinicId, result.appointmentId)).toEqual(
      result,
    );
  });
  it('uses the same engine for walk-ins followed by explicit check-in', async () => {
    const { service } = setup([]);
    const booked = await service.book({ ...request, source: 'WalkIn' });
    const checkedIn = await service.transition({
      clinicId: clinic.clinicId,
      appointmentId: booked.appointmentId,
      to: 'CheckedIn',
      actor,
    });
    expect(checkedIn).toMatchObject({
      source: 'WalkIn',
      status: 'CheckedIn',
      checkedInAt: now.toISOString(),
    });
  });
  it('does not treat previously displayed availability as a reservation', async () => {
    const { service } = setup([]);
    expect(await service.availability(clinic.clinicId, date)).toHaveLength(3);
    await service.book(request);
    await expect(service.book(request)).rejects.toMatchObject({
      code: 'SlotConflict',
    });
  });
  it.each(['09:00', '09:10'])(
    'allows exactly one of concurrent conflicting requests (second start %s)',
    async (secondStart) => {
      const { service, store } = setup(
        [],
        [hours, { ...hours, startTime: '09:10' }],
      );
      const results = await Promise.allSettled([
        service.book(request),
        service.book({ ...request, startTime: secondStart }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toEqual([
        expect.objectContaining({
          reason: expect.objectContaining({ code: 'SlotConflict' }),
        }),
      ]);
      expect(await store.listByDate(clinic.clinicId, date)).toHaveLength(1);
    },
  );
  it('permits adjacent concurrent bookings', async () => {
    const { service } = setup([]);
    const results = await Promise.all([
      service.book(request),
      service.book({ ...request, startTime: '09:20' }),
    ]);
    expect(results).toHaveLength(2);
  });
  it('releases a cancelled future slot while preserving its record', async () => {
    const { service, store } = setup();
    await service.transition({
      clinicId: clinic.clinicId,
      appointmentId: 'existing',
      to: 'Cancelled',
      actor,
    });
    expect(await service.book(request)).toMatchObject({ status: 'Scheduled' });
    expect(await store.findById(clinic.clinicId, 'existing')).toMatchObject({
      status: 'Cancelled',
      cancelledAt: now.toISOString(),
    });
  });
  it('rejects a missing clinic', async () => {
    const { service } = setup([]);
    await expect(
      service.book({ ...request, clinicId: 'missing' }),
    ).rejects.toMatchObject({ code: 'ClinicNotFound' });
  });
  it.each([
    { patientId: '' },
    { patientName: ' ' },
    { whatsappNumber: 'invalid' },
    { createdBy: '' },
  ])('rejects invalid administrative input %j', async (overrides) => {
    const { service, store } = setup([]);
    await expect(
      service.book({ ...request, ...overrides }),
    ).rejects.toMatchObject({ code: 'InvalidInput' });
    expect(await store.listByDate(clinic.clinicId, date)).toEqual([]);
  });
  it('checks the clock after acquiring the coordinator and reading fresh data', async () => {
    const { service, store, setTime } = setup([]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = store.runExclusive(clinic.clinicId, async () => {
      await gate;
    });
    const booking = service.book(request);
    setTime('2026-09-14T04:00:00Z');
    release();
    await held;
    await expect(booking).rejects.toMatchObject({ code: 'SlotInPast' });
  });
});

describe('rescheduling', () => {
  const move = {
    clinicId: clinic.clinicId,
    appointmentId: 'existing',
    appointmentDate: date,
    startTime: '09:20',
    createdBy: actor.id,
  };
  it('preserves original booking metadata, creates a linked replacement and frees old slot', async () => {
    const { service, store } = setup();
    const replacement = await service.reschedule(move);
    expect(replacement).toMatchObject({
      appointmentId: 'new-1',
      status: 'Scheduled',
      rescheduledFrom: 'existing',
      rescheduledTo: null,
      startTime: '09:20',
    });
    expect(await store.findById(clinic.clinicId, 'existing')).toEqual({
      ...appointment(),
      status: 'Rescheduled',
      rescheduledTo: 'new-1',
    });
    expect(await service.book(request)).toMatchObject({ status: 'Scheduled' });
  });
  it('can move to a partially overlapping replacement when only the original occupies it', async () => {
    const { service } = setup(
      [appointment()],
      [hours, { ...hours, startTime: '09:10' }],
    );
    expect(
      await service.reschedule({ ...move, startTime: '09:10' }),
    ).toMatchObject({ startTime: '09:10', endTime: '09:30' });
  });
  it('keeps original unchanged when replacement conflicts', async () => {
    const { service, store } = setup([
      appointment(),
      appointment({
        appointmentId: 'other',
        startTime: '09:20',
        endTime: '09:40',
      }),
    ]);
    await expect(service.reschedule(move)).rejects.toMatchObject({
      code: 'SlotConflict',
    });
    expect(await store.findById(clinic.clinicId, 'existing')).toEqual(
      appointment(),
    );
    expect(await store.listByDate(clinic.clinicId, date)).toHaveLength(2);
  });
  it('rolls back both records on a failure after the callback has staged its writes', async () => {
    const { service, store } = setup();
    store.failNextCommit = true;
    await expect(service.reschedule(move)).rejects.toThrow(
      'Simulated commit failure',
    );
    expect(await store.findById(clinic.clinicId, 'existing')).toEqual(
      appointment(),
    );
    expect(await store.listByDate(clinic.clinicId, date)).toHaveLength(1);
  });
  it('only reschedules an original once under concurrency', async () => {
    const { service, store } = setup();
    const results = await Promise.allSettled([
      service.reschedule(move),
      service.reschedule({ ...move, startTime: '09:40' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({ code: 'InvalidReschedule' }),
      }),
    ]);
    expect(await store.listByDate(clinic.clinicId, date)).toHaveLength(2);
  });
  it('supports a reschedule chain', async () => {
    const { service, store } = setup();
    const b = await service.reschedule(move);
    const c = await service.reschedule({
      ...move,
      appointmentId: b.appointmentId,
      startTime: '09:40',
    });
    expect(c.rescheduledFrom).toBe(b.appointmentId);
    expect(
      await store.findById(clinic.clinicId, b.appointmentId),
    ).toMatchObject({
      rescheduledFrom: 'existing',
      rescheduledTo: c.appointmentId,
      status: 'Rescheduled',
    });
  });
  it.each([
    { startTime: '09:00' },
    { appointmentId: 'missing' },
    { appointmentDate: '2026-10-14' },
  ])(
    'rejects invalid reschedules without losing history %j',
    async (overrides) => {
      const { service, store } = setup();
      await expect(
        service.reschedule({ ...move, ...overrides }),
      ).rejects.toBeInstanceOf(DomainError);
      expect(await store.findById(clinic.clinicId, 'existing')).toEqual(
        appointment(),
      );
    },
  );
});

describe('lifecycle operations', () => {
  it('checks in and completes with timestamps', async () => {
    const { service, setTime } = setup();
    await service.transition({
      clinicId: clinic.clinicId,
      appointmentId: 'existing',
      to: 'CheckedIn',
      actor,
    });
    setTime('2026-09-14T04:20:00Z');
    expect(
      await service.transition({
        clinicId: clinic.clinicId,
        appointmentId: 'existing',
        to: 'Completed',
        actor,
      }),
    ).toMatchObject({
      status: 'Completed',
      checkedInAt: now.toISOString(),
      completedAt: '2026-09-14T04:20:00.000Z',
    });
  });
  it('requires an explicit clerk action for NoShow and never marks one on reads', async () => {
    const { service, store, setTime } = setup();
    setTime('2026-09-14T10:00:00Z');
    await service.availability(clinic.clinicId, date);
    expect(await store.findById(clinic.clinicId, 'existing')).toMatchObject({
      status: 'Scheduled',
    });
    await expect(
      service.transition({
        clinicId: clinic.clinicId,
        appointmentId: 'existing',
        to: 'NoShow',
        actor: { id: 'patient-example', role: 'Patient' },
      }),
    ).rejects.toMatchObject({ code: 'InvalidAppointmentTransition' });
    expect(
      await service.transition({
        clinicId: clinic.clinicId,
        appointmentId: 'existing',
        to: 'NoShow',
        actor,
      }),
    ).toMatchObject({ status: 'NoShow' });
  });
  it.each(['Completed', 'Scheduled', 'Rescheduled'] as const)(
    'rejects invalid or shortcut status %s',
    async (to) => {
      const { service } = setup();
      await expect(
        service.transition({
          clinicId: clinic.clinicId,
          appointmentId: 'existing',
          to,
          actor,
        }),
      ).rejects.toMatchObject({ code: 'InvalidAppointmentTransition' });
    },
  );
  it('can complete before the appointment start when check-in has already occurred', async () => {
    const { service } = setup([
      appointment({ status: 'CheckedIn', checkedInAt: now.toISOString() }),
    ]);
    await expect(
      service.transition({
        clinicId: clinic.clinicId,
        appointmentId: 'existing',
        to: 'Completed',
        actor,
      }),
    ).resolves.toMatchObject({
      status: 'Completed',
      completedAt: now.toISOString(),
    });
  });
  it('returns typed not-found for a missing appointment', async () => {
    const { service } = setup([]);
    await expect(
      service.transition({
        clinicId: clinic.clinicId,
        appointmentId: 'missing',
        to: 'Cancelled',
        actor,
      }),
    ).rejects.toMatchObject({ code: 'AppointmentNotFound' });
  });
});
