import { DomainError } from '../shared/errors.js';

const DAY_MS = 86_400_000;

/** Date-only UTC arithmetic represents calendar dates, not clinic instants. */
export function calendarDay(date: string): number {
  const ms = Date.parse(`${date}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(ms) ||
    new Date(ms).toISOString().slice(0, 10) !== date
  ) {
    throw new DomainError('InvalidInput', 'Expected a valid YYYY-MM-DD date');
  }
  return ms / DAY_MS;
}

export function minutes(time: string): number {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    throw new DomainError(
      'InvalidInput',
      'Expected HH:mm from 00:00 through 23:59',
    );
  }
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
}

export function formatMinutes(value: number): string {
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

function formatter(timezone: string): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      calendar: 'iso8601',
      numberingSystem: 'latn',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
  } catch {
    throw new DomainError(
      'InvalidClinicConfiguration',
      'Unsupported clinic timezone',
    );
  }
}

function wallTime(fmt: Intl.DateTimeFormat, ms: number): string {
  const parts = Object.fromEntries(
    fmt.formatToParts(ms).map((p) => [p.type, p.value]),
  );
  return `${parts.year?.padStart(4, '0')}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

export function instantMilliseconds(now: Date): number {
  const ms = now.getTime();
  if (!Number.isFinite(ms))
    throw new DomainError('InvalidInput', 'Clock returned an invalid instant');
  return ms;
}

/** Reject implicit local timezone parsing and normalized impossible dates. */
export function timestampMilliseconds(value: string | null): number {
  if (
    value === null ||
    !/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?Z$/.test(
      value,
    )
  ) {
    throw new DomainError(
      'InvalidSchedule',
      'Expected a UTC ISO event timestamp',
    );
  }
  try {
    calendarDay(value.slice(0, 10));
  } catch {
    throw new DomainError('InvalidSchedule', 'Invalid event timestamp date');
  }
  return Date.parse(value);
}

export function localDateAt(now: Date, timezone: string): string {
  return wallTime(formatter(timezone), instantMilliseconds(now)).slice(0, 10);
}

/**
 * Resolve only unambiguous wall times. Samples discover nearby timezone offsets;
 * every candidate is round-tripped. DST gaps/folds fail closed because the model
 * cannot identify which occurrence of a repeated local time the caller intended.
 */
export function localTimeResolver(
  date: string,
  timezone: string,
): (time: string) => number {
  const midnight = calendarDay(date) * DAY_MS;
  const fmt = formatter(timezone);
  const offsets = new Set<number>();
  for (let hours = -36; hours <= 36; hours += 6) {
    const sample = midnight + hours * 3_600_000;
    offsets.add(Date.parse(`${wallTime(fmt, sample)}Z`) - sample);
  }
  return (time) => {
    const target = midnight + minutes(time) * 60_000;
    const matching = [...offsets]
      .map((offset) => target - offset)
      .filter((ms) => wallTime(fmt, ms) === `${date}T${time}:00`);
    if (matching.length !== 1) {
      throw new DomainError(
        'InvalidLocalTime',
        'Nonexistent or ambiguous clinic-local time',
      );
    }
    return matching[0]!;
  };
}

export function resolveLocalInstant(
  date: string,
  time: string,
  timezone: string,
): number {
  return localTimeResolver(date, timezone)(time);
}
