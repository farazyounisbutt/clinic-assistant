import { loadConfig } from '../../src/config/index.js';
import type { Appointment } from '../../src/appointments/models.js';
import type { WorkingHours } from '../../src/scheduling/models.js';
import type { SchedulingSnapshot } from '../../src/scheduling/availability.js';

// Entirely synthetic hours, not the any real clinic's schedule.
export const clinic = loadConfig({}).clinic;
export const now = new Date('2026-09-14T03:00:00.000Z'); // Monday 08:00 Karachi
export const date = '2026-09-14';
export const hours: WorkingHours = {
  clinicId: clinic.clinicId,
  dayOfWeek: 1,
  active: true,
  startTime: '09:00',
  endTime: '10:00',
};
export function appointment(overrides: Partial<Appointment> = {}): Appointment {
  return {
    appointmentId: 'existing',
    clinicId: clinic.clinicId,
    patientId: 'patient-example',
    patientName: 'Example Patient',
    whatsappNumber: '+12025550123',
    appointmentDate: date,
    startTime: '09:00',
    endTime: '09:20',
    source: 'WhatsApp',
    status: 'Scheduled',
    bookedAt: '2026-09-13T03:00:00.000Z',
    checkedInAt: null,
    completedAt: null,
    cancelledAt: null,
    rescheduledFrom: null,
    rescheduledTo: null,
    createdBy: 'clerk-example',
    ...overrides,
  };
}
export function snapshot(
  overrides: Partial<SchedulingSnapshot> = {},
): SchedulingSnapshot {
  return {
    clinic,
    workingHours: [hours],
    blockedSlots: [],
    appointments: [],
    ...overrides,
  };
}
