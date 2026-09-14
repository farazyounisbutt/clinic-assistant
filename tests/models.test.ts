import { expect, expectTypeOf, it } from 'vitest';
import {
  AppointmentSource,
  AppointmentStatus,
  SubscriptionStatus,
} from '../src/index.js';
import type {
  Appointment,
  Patient,
  WorkingHours,
  BlockedSlot,
} from '../src/index.js';

it('keeps external source and status values stable', () => {
  expect(Object.values(AppointmentSource)).toEqual([
    'WhatsApp',
    'WalkIn',
    'Clerk',
    'Phone',
  ]);
  expect(Object.values(AppointmentStatus)).toEqual([
    'Scheduled',
    'CheckedIn',
    'Completed',
    'NoShow',
    'Cancelled',
    'Rescheduled',
  ]);
  expect(Object.values(SubscriptionStatus)).toEqual([
    'active',
    'inactive',
    'suspended',
  ]);
});

it('models clinic-scoped administrative records and nullable lifecycle metadata', () => {
  const patient: Patient = {
    patientId: 'patient-example',
    clinicId: 'example',
    name: 'Example Patient',
    whatsappNumber: '+12025550123',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  const appointment: Appointment = {
    appointmentId: 'appointment-example',
    clinicId: patient.clinicId,
    patientId: patient.patientId,
    patientName: patient.name,
    whatsappNumber: patient.whatsappNumber,
    appointmentDate: '2026-01-02',
    startTime: '09:00',
    endTime: '09:20',
    source: AppointmentSource.WalkIn,
    status: AppointmentStatus.Scheduled,
    bookedAt: patient.createdAt,
    checkedInAt: null,
    completedAt: null,
    cancelledAt: null,
    rescheduledFrom: null,
    rescheduledTo: null,
    createdBy: 'clerk-example',
  };
  expectTypeOf(appointment).toEqualTypeOf<Appointment>();
  expect(appointment.clinicId).toBe(patient.clinicId);
  expect(appointment.checkedInAt).toBeNull();
  expectTypeOf<WorkingHours['dayOfWeek']>().toEqualTypeOf<
    1 | 2 | 3 | 4 | 5 | 6 | 7
  >();
  expectTypeOf<BlockedSlot['clinicId']>().toEqualTypeOf<string>();
  expectTypeOf<Patient>().not.toHaveProperty('diagnosis');
  expectTypeOf<Patient>().not.toHaveProperty('cnic');
});
