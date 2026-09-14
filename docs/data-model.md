# Data model

All IDs are opaque strings. Clinic-owned records include `clinicId`; related records
must belong to the same clinic. IDs are not spreadsheet row numbers. Models use
readonly properties and readonly collections to discourage accidental mutation.

Dates use local `YYYY-MM-DD`; times use local 24-hour `HH:mm` in the clinic timezone.
Event timestamps use UTC ISO 8601 strings. These are documented string aliases,
not runtime-validated date types. Future adapters must validate formats and ranges.
Proposed scheduling convention: half-open intervals `[startTime, endTime)` so
adjacent appointments can share a boundary; overnight rules need clinic confirmation.

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

Patient contact numbers should be normalized to E.164 by future boundary validation.
Appointment name and number are booking-time snapshots; changes to the patient
record do not rewrite historical appointments. `createdBy` is an internal actor ID;
actor authentication and authorization are not yet implemented.

`bookedAt` is required. `checkedInAt`, `completedAt`, and `cancelledAt` are explicitly
`null` until the corresponding event. `rescheduledFrom` and `rescheduledTo` are
appointment IDs or `null`. Optional `reason` is omitted when absent. Do not use
reasons to collect symptoms, diagnoses, or other clinical information.

Sources: `WhatsApp`, `WalkIn`, `Clerk`, `Phone`.
Statuses: `Scheduled`, `CheckedIn`, `Completed`, `NoShow`, `Cancelled`, `Rescheduled`.
Active appointments for availability are `Scheduled` and `CheckedIn`.

Subscription values are `active`, `inactive`, and `suspended`. Only the active demo
default is agreed; the additional vocabulary is a foundation assumption to confirm
before implementing access policy. There is no billing behavior.

Never store medical history, diagnosis, prescriptions, CNIC, or other clinical
records. TypeScript types do not strip unexpected fields; future input adapters
must allowlist fields. Fixtures must remain synthetic; exports belong to the clinic.
