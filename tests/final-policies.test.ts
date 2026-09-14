import { describe, expect, it } from 'vitest';
import { AppointmentService } from '../src/appointments/service.js';
import {
  assertSlotAvailable,
  getAvailableSlots,
} from '../src/scheduling/availability.js';
import { InMemoryAppointmentStore } from './support/in-memory-store.js';
import {
  appointment,
  clinic,
  date,
  hours,
  now,
  snapshot,
} from './support/fixtures.js';

const actor = { id: 'clerk-example', role: 'Clerk' as const };
const request = {
  clinicId: clinic.clinicId,
  patientId: 'patient-example',
  patientName: 'Example Patient',
  whatsappNumber: '+12025550123',
  appointmentDate: date,
  startTime: '09:20',
  source: 'WhatsApp' as const,
  createdBy: actor.id,
};

function setup(
  subscriptionStatus: 'active' | 'inactive' | 'suspended' = 'active',
  records = [appointment()],
  instant = now,
) {
  const store = new InMemoryAppointmentStore({
    clinics: [{ ...clinic, subscriptionStatus }],
    workingHours: [hours],
    appointments: records,
  });
  let id = 0;
  return {
    store,
    service: new AppointmentService(
      store,
      { now: () => instant },
      { next: () => `new-${++id}` },
    ),
  };
}

describe('generated slot grid', () => {
  it.each(['WhatsApp', 'Clerk', 'Phone', 'WalkIn'] as const)(
    'rejects off-grid %s bookings without storing them',
    async (source) => {
      const { service, store } = setup('active', []);
      await expect(
        service.book({ ...request, source, startTime: '09:05' }),
      ).rejects.toMatchObject({ code: 'SlotOffGrid' });
      expect(await store.listByDate(clinic.clinicId, date)).toEqual([]);
    },
  );
  it('rejects off-grid rescheduling and preserves the original', async () => {
    const { service, store } = setup();
    await expect(
      service.reschedule({
        clinicId: clinic.clinicId,
        appointmentId: 'existing',
        appointmentDate: date,
        startTime: '09:05',
        createdBy: actor.id,
      }),
    ).rejects.toMatchObject({ code: 'SlotOffGrid' });
    expect(await store.findById(clinic.clinicId, 'existing')).toEqual(
      appointment(),
    );
  });
  it('anchors each grid to its own working period and appointment duration', () => {
    const state = snapshot({
      clinic: { ...clinic, appointmentDurationMinutes: 15 },
      workingHours: [{ ...hours, startTime: '09:05' }],
    });
    expect(
      getAvailableSlots(state, date, now).map((slot) => slot.startTime),
    ).toEqual(['09:05', '09:20', '09:35']);
    expect(assertSlotAvailable(state, date, '09:20', now)).toEqual({
      startTime: '09:20',
      endTime: '09:35',
    });
    expect(() => assertSlotAvailable(state, date, '09:15', now)).toThrowError(
      expect.objectContaining({ code: 'SlotOffGrid' }),
    );
  });
  it('does not borrow a grid anchor from a period too short to contain the appointment', () => {
    const state = snapshot({
      workingHours: [
        { ...hours, endTime: '09:10' },
        { ...hours, startTime: '08:55' },
      ],
    });
    expect(() => assertSlotAvailable(state, date, '09:00', now)).toThrowError(
      expect.objectContaining({ code: 'SlotOffGrid' }),
    );
  });
});

describe.each(['inactive', 'suspended'] as const)(
  '%s subscription policy',
  (subscriptionStatus) => {
    it.each(['WhatsApp', 'Clerk', 'Phone', 'WalkIn'] as const)(
      'blocks new %s appointments',
      async (source) => {
        const { service, store } = setup(subscriptionStatus);
        await expect(
          service.book({ ...request, source }),
        ).rejects.toMatchObject({ code: 'SubscriptionInactive' });
        expect(await store.listByDate(clinic.clinicId, date)).toEqual([
          appointment(),
        ]);
      },
    );
    it('blocks rescheduling without changing existing records', async () => {
      const { service, store } = setup(subscriptionStatus);
      await expect(
        service.reschedule({
          clinicId: clinic.clinicId,
          appointmentId: 'existing',
          appointmentDate: date,
          startTime: '09:20',
          createdBy: actor.id,
        }),
      ).rejects.toMatchObject({ code: 'SubscriptionInactive' });
      expect(await store.findById(clinic.clinicId, 'existing')).toEqual(
        appointment(),
      );
    });
    it.each(['CheckedIn', 'Cancelled', 'NoShow'] as const)(
      'allows explicit %s management',
      async (to) => {
        const { service } = setup(subscriptionStatus);
        expect(
          await service.transition({
            clinicId: clinic.clinicId,
            appointmentId: 'existing',
            to,
            actor,
          }),
        ).toMatchObject({ status: to });
      },
    );
    it('allows early completion and preserves logically ordered timestamps', async () => {
      const { service } = setup(subscriptionStatus, [
        appointment({
          status: 'CheckedIn',
          checkedInAt: '2026-09-14T02:50:00Z',
        }),
      ]);
      expect(
        await service.transition({
          clinicId: clinic.clinicId,
          appointmentId: 'existing',
          to: 'Completed',
          actor,
        }),
      ).toMatchObject({
        completedAt: now.toISOString(),
        checkedInAt: '2026-09-14T02:50:00Z',
      });
    });
    it('allows reading/exporting existing records outside the booking horizon', async () => {
      const record = appointment({ appointmentDate: '2026-01-01' });
      const { service } = setup(subscriptionStatus, [record]);
      expect(
        await service.listAppointments(clinic.clinicId, '2026-01-01'),
      ).toEqual([record]);
    });
  },
);

describe('early completion timestamp ordering', () => {
  it('frees the future grid slot after early check-in and completion', async () => {
    const { service } = setup();
    await service.transition({
      clinicId: clinic.clinicId,
      appointmentId: 'existing',
      to: 'CheckedIn',
      actor,
    });
    await service.transition({
      clinicId: clinic.clinicId,
      appointmentId: 'existing',
      to: 'Completed',
      actor,
    });
    expect(await service.availability(clinic.clinicId, date)).toHaveLength(3);
    expect(
      await service.book({ ...request, startTime: '09:00' }),
    ).toMatchObject({ status: 'Scheduled' });
  });
  it('rejects completion before check-in and preserves the existing record', async () => {
    const original = appointment({
      status: 'CheckedIn',
      checkedInAt: '2026-09-14T03:01:00Z',
    });
    const { service, store } = setup('active', [original]);
    await expect(
      service.transition({
        clinicId: clinic.clinicId,
        appointmentId: 'existing',
        to: 'Completed',
        actor,
      }),
    ).rejects.toMatchObject({ code: 'InvalidAppointmentTransition' });
    expect(await store.findById(clinic.clinicId, 'existing')).toEqual(original);
  });
  it('rejects an inconsistent check-in that predates booking', async () => {
    const { service } = setup('active', [
      appointment({ status: 'CheckedIn', checkedInAt: '2026-09-12T03:00:00Z' }),
    ]);
    await expect(
      service.transition({
        clinicId: clinic.clinicId,
        appointmentId: 'existing',
        to: 'Completed',
        actor,
      }),
    ).rejects.toMatchObject({ code: 'InvalidAppointmentTransition' });
  });
  it('does not expose another clinic through the existing-record read operation', async () => {
    const { service } = setup();
    await expect(service.listAppointments('other', date)).rejects.toMatchObject(
      { code: 'ClinicNotFound' },
    );
    await expect(
      service.listAppointments(clinic.clinicId, 'invalid'),
    ).rejects.toMatchObject({ code: 'InvalidInput' });
  });
});
