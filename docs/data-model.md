# Data model

All IDs are opaque strings. Clinic-owned records include `clinicId`; related records
must belong to the same clinic. IDs are not spreadsheet row numbers. Models use
readonly properties and readonly collections to discourage accidental mutation.

Dates use local `YYYY-MM-DD`; times use local 24-hour `HH:mm` in the clinic timezone.
Event timestamps use UTC ISO 8601 strings ending in Z. These remain string aliases;
the scheduling and lifecycle functions validate the values they consume at runtime.
Future adapters must still validate complete records and reject unexpected fields.
Intervals are half-open `[startTime, endTime)` so adjacent appointments can share a
boundary. Only same-day intervals with endpoints from 00:00 to 23:59 are supported.
See [availability](availability.md) for time conversion and DST limitations.

| Model        | Fields                                                                                                                                                                                                                            |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clinic       | clinicId, doctorName, specialty, timezone, appointmentDurationMinutes, bookingHorizonDays, sameDayBookingAllowed, subscriptionStatus                                                                                              |
| WorkingHours | clinicId, dayOfWeek, active, startTime, endTime, optional breaks                                                                                                                                                                  |
| BlockedSlot  | id, clinicId, date, startTime, endTime, reason                                                                                                                                                                                    |
| Patient      | patientId, clinicId, name, whatsappNumber, createdAt                                                                                                                                                                              |
| Appointment  | appointmentId, clinicId, patientId, patientName, whatsappNumber, appointmentDate, startTime, endTime, optional reason, source, status, bookedAt, checkedInAt, completedAt, cancelledAt, rescheduledFrom, rescheduledTo, createdBy |

`dayOfWeek` uses ISO numbering (Monday 1 through Sunday 7). Breaks contain start and
end times. An inactive working-hours record contributes no availability. Real hours
are not seeded. A blocked-slot reason is an administrative label.

Booking requires an E.164-shaped contact number, except a contactless WalkIn may use an empty string; future input adapters must normalize
numbers and verify any additional contact requirements before calling the service.
Appointment name and number are booking-time snapshots; changes to the patient
record do not rewrite historical appointments. `createdBy` is an internal actor ID;
the WhatsApp clerk boundary resolves that ID through clinic-scoped runtime operator authorization. The NoShow
operation requires trusted Clerk role context. Transition timestamps are recorded,
and transition actors/timestamps are persisted in Activity_Log (see
[SQLite schema](persistence.md) and [projection columns](sheets-schema.md)).

`bookedAt` is required. `checkedInAt`, `completedAt`, and `cancelledAt` are explicitly
`null` until the corresponding event. `rescheduledFrom` and `rescheduledTo` are
appointment IDs or `null`. Optional `reason` is omitted when absent. Do not use
reasons to collect symptoms, diagnoses, or other clinical information.

Sources: `WhatsApp`, `WalkIn`, `Clerk`, `Phone`.
Statuses: `Scheduled`, `CheckedIn`, `Completed`, `NoShow`, `Cancelled`, `Rescheduled`.
Active appointments for availability are `Scheduled` and `CheckedIn`. Completed
records do not block availability, including patients seen before their scheduled
start. Future-start validation still independently prevents booking a past slot.
Event timestamps are ordered by actual booking/check-in/completion, not by the
planned appointment start.

Subscription values are `active`, `inactive`, and `suspended`. Only active allows
availability, booking, and rescheduling. Existing-appointment lifecycle changes
and existing-record reads/exports remain allowed for inactive/suspended clinics.
New WalkIn reservations are new bookings and are blocked. This is application policy;
there is no payment-provider or billing behavior.

Appointment duration must be a positive integer up to 1440 minutes and must fit
within a working period. Booking horizon is a positive count of local dates,
including today. Zero is invalid. The demo value of 30 means today through day 29.

Never store medical history, diagnosis, prescriptions, CNIC, or other clinical
records. TypeScript types do not strip unexpected fields; future input adapters
must allowlist fields. Fixtures must remain synthetic; exports belong to the clinic.

Real clinic identity, doctor name, specialty, working hours, WhatsApp number, and
customer-specific settings belong in runtime clinic configuration/data. Repository
examples use demo_clinic, Demo Doctor, Specialist, and synthetic contact details.

## Optional daily capacity

Clinic settings may include `dailyAppointmentLimit`, a positive safe integer.
Omitted means unlimited. See [capacity policy and migration](daily-capacity-and-development-hours.md).
