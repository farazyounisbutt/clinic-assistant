import type { Appointment } from '../appointments/models.js';
import { AppointmentStatus } from '../appointments/models.js';
import { isActiveAppointmentStatus } from '../appointments/lifecycle.js';
import type { Clinic } from '../clinic/models.js';
import { assertClinicCanBook } from '../clinic/validation.js';
import { DomainError } from '../shared/errors.js';
import type { DomainErrorCode } from '../shared/errors.js';
import type { TimeRange } from '../shared/types.js';
import type { BlockedSlot, WorkingHours } from './models.js';
import {
  calendarDay,
  formatMinutes,
  instantMilliseconds,
  localDateAt,
  localTimeResolver,
  minutes,
} from './time.js';

export interface SchedulingSnapshot {
  readonly clinic: Clinic | null;
  readonly workingHours: readonly WorkingHours[];
  readonly blockedSlots: readonly BlockedSlot[];
  readonly appointments: readonly Appointment[];
}

interface Interval {
  readonly start: number;
  readonly end: number;
}

function interval(range: TimeRange): Interval {
  try {
    const start = minutes(range.startTime);
    const end = minutes(range.endTime);
    if (start >= end) throw new DomainError('InvalidSchedule');
    return { start, end };
  } catch {
    throw new DomainError(
      'InvalidSchedule',
      'Expected a positive same-day interval',
    );
  }
}

/** Half-open intervals: touching endpoints never overlap. */
export function intervalsOverlap(left: TimeRange, right: TimeRange): boolean {
  return overlap(interval(left), interval(right));
}

function overlap(left: Interval, right: Interval): boolean {
  return left.start < right.end && right.start < left.end;
}

function prepare(snapshot: SchedulingSnapshot, date: string, now: Date) {
  const { clinic } = snapshot;
  assertClinicCanBook(clinic);
  const day = calendarDay(date);
  const today = calendarDay(localDateAt(now, clinic.timezone));
  if (day < today || day - today >= clinic.bookingHorizonDays)
    throw new DomainError('DateOutsideBookingHorizon');
  if (day === today && !clinic.sameDayBookingAllowed)
    throw new DomainError('SameDayBookingDisabled');
  const weekday = ((new Date(day * 86_400_000).getUTCDay() + 6) % 7) + 1;
  const relevantHours = snapshot.workingHours.filter(
    (h) => h.clinicId === clinic.clinicId,
  );
  if (
    relevantHours.some(
      (h) =>
        !Number.isInteger(h.dayOfWeek) ||
        h.dayOfWeek < 1 ||
        h.dayOfWeek > 7 ||
        typeof h.active !== 'boolean',
    )
  ) {
    throw new DomainError('InvalidSchedule', 'Invalid weekday or active flag');
  }
  const hours = relevantHours.filter(
    (h) => h.active && h.dayOfWeek === weekday,
  );
  const periods = hours.map(interval);
  const breaks = hours.flatMap((h) =>
    (h.breaks ?? []).map((b) => {
      const pause = interval(b);
      const period = interval(h);
      if (pause.start < period.start || pause.end > period.end)
        throw new DomainError(
          'InvalidSchedule',
          'Break must be inside its working period',
        );
      return pause;
    }),
  );
  const blocks = snapshot.blockedSlots
    .filter((b) => b.clinicId === clinic.clinicId && b.date === date)
    .map(interval);
  const resolve = localTimeResolver(date, clinic.timezone);
  const nowMs = instantMilliseconds(now);
  const records = snapshot.appointments.filter(
    (a) => a.clinicId === clinic.clinicId && a.appointmentDate === date,
  );
  for (const record of records) {
    if (!Object.values(AppointmentStatus).includes(record.status))
      throw new DomainError('InvalidSchedule', 'Unknown appointment status');
  }
  const appointments = records
    .filter((a) => isActiveAppointmentStatus(a.status))
    .map(interval);
  return { clinic, periods, breaks, blocks, appointments, resolve, nowMs };
}

type Context = ReturnType<typeof prepare>;

function validateSlot(context: Context, startTime: string): TimeRange {
  const start = minutes(startTime);
  const end = start + context.clinic.appointmentDurationMinutes;
  if (!context.periods.length) throw new DomainError('ClinicClosed');
  if (!context.periods.some((p) => p.start <= start && p.end >= end))
    throw new DomainError('SlotOutsideWorkingHours');
  if (
    !context.periods.some(
      (p) =>
        p.start <= start &&
        p.end >= end &&
        (start - p.start) % context.clinic.appointmentDurationMinutes === 0,
    )
  ) {
    throw new DomainError(
      'SlotOffGrid',
      'Start must lie on a generated slot grid',
    );
  }
  const slot = { startTime, endTime: formatMinutes(end) };
  const startMs = context.resolve(startTime);
  const endMs = context.resolve(slot.endTime);
  if (endMs - startMs !== context.clinic.appointmentDurationMinutes * 60_000) {
    throw new DomainError(
      'InvalidLocalTime',
      'Appointment cannot cross a timezone offset change',
    );
  }
  // Single policy boundary where a configurable lead time can later be added.
  if (startMs <= context.nowMs) throw new DomainError('SlotInPast');
  const candidate = { start, end };
  if (context.breaks.some((b) => overlap(candidate, b)))
    throw new DomainError('SlotOverlapsBreak');
  if (context.blocks.some((b) => overlap(candidate, b)))
    throw new DomainError('SlotBlocked');
  if (context.appointments.some((a) => overlap(candidate, a)))
    throw new DomainError('SlotConflict');
  return slot;
}

/** Authoritative when invoked with fresh data inside the atomic write coordinator. */
export function assertSlotAvailable(
  snapshot: SchedulingSnapshot,
  date: string,
  startTime: string,
  now: Date,
): TimeRange {
  return validateSlot(prepare(snapshot, date, now), startTime);
}

const unavailable: readonly DomainErrorCode[] = [
  'SlotInPast',
  'SlotOverlapsBreak',
  'SlotBlocked',
  'SlotConflict',
  'InvalidLocalTime',
];

/** Display only: these results never reserve a slot. Closed days return []. */
export function getAvailableSlots(
  snapshot: SchedulingSnapshot,
  date: string,
  now: Date,
): readonly TimeRange[] {
  const context = prepare(snapshot, date, now);
  const starts = new Set<number>();
  for (const period of context.periods) {
    for (
      let start = period.start;
      start + context.clinic.appointmentDurationMinutes <= period.end;
      start += context.clinic.appointmentDurationMinutes
    )
      starts.add(start);
  }
  return [...starts]
    .sort((a, b) => a - b)
    .flatMap((start) => {
      try {
        return [validateSlot(context, formatMinutes(start))];
      } catch (error) {
        if (error instanceof DomainError && unavailable.includes(error.code))
          return [];
        throw error;
      }
    });
}
