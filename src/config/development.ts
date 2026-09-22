import type { ClinicConfiguration } from '../ports/projection.js';
import { DomainError } from '../shared/errors.js';

/** Explicit development-only schedule; never applied by normal clinic provisioning. */
export function developmentEveningHours(
  config: ClinicConfiguration,
): ClinicConfiguration {
  if (
    config.clinic.clinicId !== 'integration_test_clinic' ||
    config.clinic.timezone !== 'Asia/Karachi'
  )
    throw new DomainError('InvalidInput', 'Development clinic only');
  // Refuse unfamiliar layouts rather than silently discard breaks or extra periods.
  if (
    config.workingHours.length !== 7 ||
    ![1, 2, 3, 4, 5, 6, 7].every(
      (day) =>
        config.workingHours.filter((h) => h.dayOfWeek === day).length === 1,
    ) ||
    config.workingHours.some(
      (h) =>
        h.clinicId !== config.clinic.clinicId ||
        !h.active ||
        h.startTime !== '09:00' ||
        !['18:00', '21:00'].includes(h.endTime),
    )
  )
    throw new DomainError(
      'InvalidSchedule',
      'Review the development schedule before extending it',
    );
  return {
    ...config,
    workingHours: config.workingHours.map((h) => ({ ...h, endTime: '21:00' })),
  };
}
