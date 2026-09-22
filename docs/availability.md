# Availability algorithm

All examples in tests use synthetic working hours. Real working hours come from
runtime clinic data; no customer schedule is seeded.

## Calendar and time rules

- Use the clinic's configured timezone, not the machine timezone or UTC date.
- Dates are valid `YYYY-MM-DD` calendar dates. Time values are `HH:mm` in 24-hour
  format, from 00:00 to 23:59. Event timestamps use UTC ISO strings ending in `Z`.
- A horizon of N means today through today + N - 1, inclusive. For an example horizon of 30
  dates, day 29 is valid and day 30 is rejected. Calendar arithmetic is independent
  of DST and handles month, year, and leap-day boundaries.
- Disabling same-day booking excludes today without extending the last horizon date.
  Such a query raises SameDayBookingDisabled; a date outside the horizon raises
  DateOutsideBookingHorizon. A valid but closed day returns an empty list.
- A start must be strictly later than the injected clock instant. Exactly now is
  already unbookable. There is no additional lead time; the comparison has one
  policy boundary where a lead-time configuration could later be added.

## Algorithm

1. Validate the clinic and require its subscription to be active.
2. Validate the requested date against the local-date horizon and same-day policy.
3. Select active working periods for that clinic and ISO weekday (Monday 1 through
   Sunday 7). No applicable periods means no availability. Any weekday can be active.
4. For each period, start at its configured start and step by the appointment
   duration. Include a candidate only if the entire interval fits that one period.
   Do not join periods across gaps. Sort candidates and deduplicate identical starts.
5. Resolve candidate endpoints to unambiguous instants in the clinic timezone and
   enforce the future-start rule and full elapsed appointment duration.
6. If a configured daily capacity is exhausted, return no slots. Capacity counts
   Scheduled, CheckedIn, Completed and NoShow, separately from interval occupancy.
7. Remove every candidate overlapping any applicable break, blocked interval, or
   Scheduled/CheckedIn appointment on the same clinic/date. Breaks from applicable
   periods are combined, so another overlapping period cannot bypass a break.

Intervals are half-open `[start, end)`. Overlap is exactly
`left.start < right.end && right.start < left.end`. Any partial overlap blocks a
slot. An appointment ending at 17:20 permits one starting at 17:20. Breaks must lie
within their working period. Malformed or reversed intervals fail with InvalidSchedule.

`assertSlotAvailable` requires the requested start to belong to a generated slot
grid: `(start - period.start) % appointmentDurationMinutes === 0` for a period that
also contains the entire appointment. It then applies all availability rules and
returns the calculated end. Off-grid starts raise SlotOffGrid. Every source, including
WalkIn, and every reschedule uses this same rule. Grids stay anchored to each period;
they do not restart after a break or an appointment. Overlapping working periods may
generate overlapping candidate alternatives; atomic interval checks still prevent
booking both.

## Status and historical records

Scheduled and CheckedIn appointments block availability by interval overlap.
Cancelled, Rescheduled, NoShow, and Completed records do not block it. A patient
may be seen and completed before the scheduled start. That future grid slot may
then be reserved again if all other checks pass. The independent future-start rule
still prevents reoffering any slot whose start has passed, regardless of status.
Unknown stored statuses fail closed. No read operation changes status.

## Time-model limitations

Working periods, breaks, blocks, and appointments must start and end on the same
local date; overnight periods and the `24:00` representation are unsupported.
Multiple separate same-day periods are supported.

Time conversion uses standard `Intl` timezone data and round-trip verification.
The current model cannot distinguish occurrences of a repeated DST wall time.
Nonexistent/ambiguous endpoints and intervals whose elapsed duration differs across
an offset change are omitted from displayed availability and rejected with
InvalidLocalTime on booking. No occurrence is guessed. These conservative limitations
need review before using the service for clinics requiring overnight or DST-transition
appointments. Test fixtures cover both ordinary and DST-transition dates.

## Confirmation

Availability is a view, never a reservation. The service reloads data and rechecks
all rules inside the final atomic booking/rescheduling operation. Every future
persistence adapter must honor the [atomic repository contract](architecture.md).

See [daily capacity](daily-capacity-and-development-hours.md) for atomic enforcement,
rescheduling credit, and configuration compatibility.
