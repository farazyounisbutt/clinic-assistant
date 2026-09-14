import type { ClinicConfiguration } from '../../ports/projection.js';
import { assertClinicConfiguration } from '../../clinic/validation.js';
import { calendarDay, minutes } from '../../scheduling/time.js';
import { intervalsOverlap } from '../../scheduling/availability.js';
import { DomainError } from '../../shared/errors.js';
import type { TimeRange } from '../../shared/types.js';

export function cleanConfiguration(
  input: ClinicConfiguration,
  clinicId: string,
): ClinicConfiguration {
  assertClinicConfiguration(input.clinic);
  const c = input.clinic;
  if (c.clinicId !== clinicId)
    throw new DomainError('InvalidInput', 'Cross-clinic configuration');
  const range = (r: TimeRange): TimeRange => {
    if (minutes(r.startTime) >= minutes(r.endTime))
      throw new DomainError('InvalidSchedule');
    return { startTime: r.startTime, endTime: r.endTime };
  };
  const workingHours = input.workingHours.map((h) => {
    if (
      h.clinicId !== clinicId ||
      !Number.isInteger(h.dayOfWeek) ||
      h.dayOfWeek < 1 ||
      h.dayOfWeek > 7 ||
      typeof h.active !== 'boolean'
    )
      throw new DomainError('InvalidSchedule');
    const period = range(h);
    const breaks = (h.breaks ?? []).map((b) => {
      const result = range(b);
      if (b.startTime < h.startTime || b.endTime > h.endTime)
        throw new DomainError('InvalidSchedule');
      return result;
    });
    return {
      clinicId,
      dayOfWeek: h.dayOfWeek,
      active: h.active,
      ...period,
      breaks,
    };
  });
  const keys = new Set<string>();
  for (const h of workingHours) {
    const key = `${h.dayOfWeek}:${h.startTime}:${h.endTime}`;
    if (keys.has(key)) throw new DomainError('InvalidSchedule');
    keys.add(key);
    if (
      h.active &&
      workingHours.some(
        (other) =>
          other !== h &&
          other.active &&
          other.dayOfWeek === h.dayOfWeek &&
          intervalsOverlap(h, other),
      )
    )
      throw new DomainError('InvalidSchedule');
  }
  const blockIds = new Set<string>();
  const blockedSlots = input.blockedSlots.map((b) => {
    if (
      b.clinicId !== clinicId ||
      !b.id.trim() ||
      typeof b.reason !== 'string' ||
      blockIds.has(b.id)
    )
      throw new DomainError('InvalidSchedule');
    blockIds.add(b.id);
    calendarDay(b.date);
    return { id: b.id, clinicId, date: b.date, ...range(b), reason: b.reason };
  });
  return {
    clinic: {
      clinicId,
      doctorName: c.doctorName,
      specialty: c.specialty,
      timezone: c.timezone,
      appointmentDurationMinutes: c.appointmentDurationMinutes,
      bookingHorizonDays: c.bookingHorizonDays,
      sameDayBookingAllowed: c.sameDayBookingAllowed,
      subscriptionStatus: c.subscriptionStatus,
    },
    workingHours,
    blockedSlots,
  };
}
