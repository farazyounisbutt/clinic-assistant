import { SubscriptionStatus } from './models.js';
import type { Clinic } from './models.js';
import { DomainError } from '../shared/errors.js';

export function assertClinicConfiguration(
  clinic: Clinic | null,
): asserts clinic is Clinic {
  if (!clinic) throw new DomainError('ClinicNotFound');
  if (
    ![
      clinic.clinicId,
      clinic.doctorName,
      clinic.specialty,
      clinic.timezone,
    ].every((value) => typeof value === 'string' && value.trim().length > 0) ||
    !Number.isSafeInteger(clinic.appointmentDurationMinutes) ||
    clinic.appointmentDurationMinutes < 1 ||
    clinic.appointmentDurationMinutes > 1440 ||
    !Number.isSafeInteger(clinic.bookingHorizonDays) ||
    clinic.bookingHorizonDays < 1 ||
    typeof clinic.sameDayBookingAllowed !== 'boolean' ||
    !Object.values(SubscriptionStatus).includes(clinic.subscriptionStatus)
  ) {
    throw new DomainError('InvalidClinicConfiguration');
  }
  try {
    new Intl.DateTimeFormat('en', { timeZone: clinic.timezone });
  } catch {
    throw new DomainError(
      'InvalidClinicConfiguration',
      'Unsupported clinic timezone',
    );
  }
}

export function assertClinicCanBook(
  clinic: Clinic | null,
): asserts clinic is Clinic {
  assertClinicConfiguration(clinic);
  if (clinic.subscriptionStatus !== SubscriptionStatus.Active)
    throw new DomainError('SubscriptionInactive');
}
