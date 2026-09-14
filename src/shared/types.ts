/** Local calendar date (YYYY-MM-DD) in the clinic timezone. */
export type LocalDate = string;
/** Local wall-clock time (HH:mm, 24-hour) in the clinic timezone. */
export type LocalTime = string;
/** UTC ISO 8601 timestamp, e.g. 2026-01-01T00:00:00.000Z. */
export type Timestamp = string;

export interface TimeRange {
  readonly startTime: LocalTime;
  readonly endTime: LocalTime;
}
