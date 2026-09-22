import type { Appointment } from '../appointments/models.js';
import type { Clinic } from '../clinic/models.js';
import { DomainError } from '../shared/errors.js';

/** Capacity policy is distinct from the statuses that occupy a time slot. */
export function consumesDailyCapacity(status: Appointment['status']): boolean {
  switch (status) {
    case 'Scheduled':
    case 'CheckedIn':
    case 'Completed':
    case 'NoShow':
      return true;
    case 'Cancelled':
    case 'Rescheduled':
      return false;
    default:
      throw new DomainError('InvalidSchedule', 'Unknown appointment status');
  }
}

export function dailyCapacity(
  clinic: Clinic,
  date: string,
  appointments: readonly Appointment[],
): { readonly used: number; readonly remaining: number | null } {
  const used = appointments.filter(
    (a) =>
      a.clinicId === clinic.clinicId &&
      a.appointmentDate === date &&
      consumesDailyCapacity(a.status),
  ).length;
  return {
    used,
    remaining:
      clinic.dailyAppointmentLimit === undefined
        ? null
        : Math.max(0, clinic.dailyAppointmentLimit - used),
  };
}

/** Final-state backstop. Lowering a limit never prevents management of old records. */
export function assertCapacityNotIncreasedBeyondLimit(
  clinic: Clinic,
  before: readonly Appointment[],
  after: readonly Appointment[],
): void {
  if (clinic.dailyAppointmentLimit === undefined) return;
  for (const date of new Set(after.map((a) => a.appointmentDate))) {
    const used = dailyCapacity(clinic, date, after).used;
    if (
      used > clinic.dailyAppointmentLimit &&
      used > dailyCapacity(clinic, date, before).used
    )
      throw new DomainError('DailyCapacityReached');
  }
}
