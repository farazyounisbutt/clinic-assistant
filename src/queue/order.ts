import type { Appointment } from '../appointments/models.js';
import {
  calendarDay,
  minutes,
  timestampMilliseconds,
} from '../scheduling/time.js';

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Pure, clinic/date-scoped ordering; appointment ID breaks otherwise equal ties. */
export function orderCheckedInQueue(
  records: readonly Appointment[],
  clinicId: string,
  date: string,
): readonly Appointment[] {
  calendarDay(date);
  return records
    .filter(
      (a) =>
        a.clinicId === clinicId &&
        a.appointmentDate === date &&
        a.status === 'CheckedIn',
    )
    .map((record) => {
      const arrival = timestampMilliseconds(record.checkedInAt);
      return { record, arrival, start: minutes(record.startTime) };
    })
    .sort(
      (a, b) =>
        a.arrival - b.arrival ||
        a.start - b.start ||
        compareText(a.record.appointmentId, b.record.appointmentId),
    )
    .map(({ record }) => record);
}
