import type { LocalDate, TimeRange } from '../shared/types.js';

/** ISO weekday numbering: Monday = 1, Sunday = 7. */
export type DayOfWeek = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface WorkingHours extends TimeRange {
  readonly clinicId: string;
  readonly dayOfWeek: DayOfWeek;
  readonly active: boolean;
  readonly breaks?: readonly TimeRange[];
}

export interface BlockedSlot extends TimeRange {
  readonly id: string;
  readonly clinicId: string;
  readonly date: LocalDate;
  readonly reason: string;
}
