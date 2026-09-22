import { describe, expect, it } from 'vitest';
import { AppointmentService } from '../src/appointments/service.js';
import type { Appointment } from '../src/appointments/models.js';
import { assertClinicConfiguration } from '../src/clinic/validation.js';
import { loadConfig } from '../src/config/index.js';
import {
  dailyCapacity,
  consumesDailyCapacity,
} from '../src/scheduling/capacity.js';
import { getAvailableSlots } from '../src/scheduling/availability.js';
import { InMemoryAppointmentStore } from './support/in-memory-store.js';
import {
  appointment,
  clinic,
  date,
  hours,
  now,
  snapshot,
} from './support/fixtures.js';

const limited = { ...clinic, dailyAppointmentLimit: 1 };
const request = {
  clinicId: clinic.clinicId,
  patientId: 'test-patient',
  patientName: 'Synthetic Patient',
  whatsappNumber: '+12025550123',
  appointmentDate: date,
  startTime: '09:00',
  source: 'WhatsApp' as const,
  createdBy: 'test',
};
function setup(records: Appointment[] = [], limit: number | undefined = 1) {
  const store = new InMemoryAppointmentStore({
    clinics: [
      {
        ...clinic,
        ...(limit === undefined ? {} : { dailyAppointmentLimit: limit }),
      },
    ],
    workingHours: [hours, { ...hours, dayOfWeek: 2 }],
    appointments: records,
  });
  let id = 0;
  const service = new AppointmentService(
    store,
    { now: () => now },
    { next: () => `new-${++id}` },
  );
  return { store, service };
}
describe('daily capacity policy', () => {
  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, '20'])(
    'rejects invalid configured limit %s',
    (value) => {
      expect(() =>
        assertClinicConfiguration({
          ...clinic,
          dailyAppointmentLimit: value,
        } as typeof limited),
      ).toThrow();
    },
  );
  it('loads an optional positive environment value and leaves old clinics unlimited', () => {
    expect(loadConfig({}).clinic).not.toHaveProperty('dailyAppointmentLimit');
    expect(
      loadConfig({ DAILY_APPOINTMENT_LIMIT: '7' }).clinic.dailyAppointmentLimit,
    ).toBe(7);
    expect(() => loadConfig({ DAILY_APPOINTMENT_LIMIT: '' })).toThrow();
    expect(dailyCapacity(clinic, date, [appointment()])).toEqual({
      used: 1,
      remaining: null,
    });
  });
  it.each(['Scheduled', 'CheckedIn', 'Completed', 'NoShow'] as const)(
    '%s consumes capacity even without occupying every slot',
    (status) => {
      const records = [appointment({ status })];
      expect(dailyCapacity(limited, date, records)).toEqual({
        used: 1,
        remaining: 0,
      });
      expect(
        getAvailableSlots(
          snapshot({ clinic: limited, appointments: records }),
          date,
          now,
        ),
      ).toEqual([]);
    },
  );
  it.each(['Cancelled', 'Rescheduled'] as const)(
    '%s releases capacity',
    (status) => {
      expect(
        dailyCapacity(limited, date, [appointment({ status })]).remaining,
      ).toBe(1);
    },
  );
  it('counts only the requested clinic/local appointment date and fails closed on unknown status', () => {
    expect(
      dailyCapacity(limited, date, [
        appointment({ clinicId: 'other' }),
        appointment({ appointmentDate: '2026-09-15' }),
      ]).used,
    ).toBe(0);
    expect(() =>
      consumesDailyCapacity('invalid' as Appointment['status']),
    ).toThrow();
  });
  it('serializes different slots competing for the final place across patient and walk-in sources', async () => {
    const { service, store } = setup();
    const result = await Promise.allSettled([
      service.book(request),
      service.book({
        ...request,
        startTime: '09:20',
        source: 'WalkIn',
        whatsappNumber: '',
      }),
    ]);
    expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(result.filter((r) => r.status === 'rejected')).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({ code: 'DailyCapacityReached' }),
      }),
    ]);
    expect(await store.listByDate(clinic.clinicId, date)).toHaveLength(1);
  });
  it('does not double count a same-day reschedule at capacity and preserves links/history', async () => {
    const { service, store } = setup([appointment()]);
    const replacement = await service.reschedule({
      clinicId: clinic.clinicId,
      appointmentId: 'existing',
      appointmentDate: date,
      startTime: '09:20',
      createdBy: 'test',
    });
    expect(replacement.rescheduledFrom).toBe('existing');
    expect(await store.findById(clinic.clinicId, 'existing')).toMatchObject({
      status: 'Rescheduled',
      rescheduledTo: replacement.appointmentId,
    });
    expect(
      dailyCapacity(
        limited,
        date,
        await store.listByDate(clinic.clinicId, date),
      ).used,
    ).toBe(1);
  });
  it('rejects rescheduling into a full different day without changing the original', async () => {
    const original = appointment();
    const { service, store } = setup([
      original,
      appointment({
        appointmentId: 'tomorrow',
        appointmentDate: '2026-09-15',
        status: 'Completed',
      }),
    ]);
    await expect(
      service.reschedule({
        clinicId: clinic.clinicId,
        appointmentId: 'existing',
        appointmentDate: '2026-09-15',
        startTime: '09:20',
        createdBy: 'test',
      }),
    ).rejects.toMatchObject({ code: 'DailyCapacityReached' });
    expect(await store.findById(clinic.clinicId, 'existing')).toEqual(original);
  });
  it('moving to another day releases the old day capacity', async () => {
    const { service } = setup([appointment()]);
    await service.reschedule({
      clinicId: clinic.clinicId,
      appointmentId: 'existing',
      appointmentDate: '2026-09-15',
      startTime: '09:20',
      createdBy: 'test',
    });
    expect(await service.availability(clinic.clinicId, date)).not.toHaveLength(
      0,
    );
  });
  it('cancellation releases capacity without deleting history', async () => {
    const { service, store } = setup([appointment()]);
    await service.transition({
      clinicId: clinic.clinicId,
      appointmentId: 'existing',
      to: 'Cancelled',
      actor: { id: 'test', role: 'Patient' },
    });
    await service.book({ ...request, source: 'WalkIn', whatsappNumber: '' });
    expect(await store.listByDate(clinic.clinicId, date)).toHaveLength(2);
  });
  it('old unlimited clinics can still reserve adjacent slots', async () => {
    const store = new InMemoryAppointmentStore({
      clinics: [clinic],
      workingHours: [hours],
    });
    let id = 0;
    const service = new AppointmentService(
      store,
      { now: () => now },
      { next: () => String(++id) },
    );
    await service.book(request);
    await expect(
      service.book({ ...request, startTime: '09:20' }),
    ).resolves.toMatchObject({ status: 'Scheduled' });
  });
  it('preserves lifecycle management after a limit is lowered below existing usage', async () => {
    const { service } = setup([
      appointment(),
      appointment({
        appointmentId: 'second',
        startTime: '09:20',
        endTime: '09:40',
      }),
    ]);
    await expect(
      service.transition({
        clinicId: clinic.clinicId,
        appointmentId: 'existing',
        to: 'CheckedIn',
        actor: { id: 'test', role: 'Clerk' },
      }),
    ).resolves.toMatchObject({ status: 'CheckedIn' });
    await expect(
      service.transition({
        clinicId: clinic.clinicId,
        appointmentId: 'existing',
        to: 'Completed',
        actor: { id: 'test', role: 'Clerk' },
      }),
    ).resolves.toMatchObject({ status: 'Completed' });
    await expect(
      service.book({ ...request, startTime: '09:40' }),
    ).rejects.toMatchObject({ code: 'DailyCapacityReached' });
  });
});
