# POC scope

WhatsApp-first clinic appointment and queue management service.

Patients will use WhatsApp; clerks will use WhatsApp and Google Sheets; doctors
will receive WhatsApp summaries/reports. InLoop operates the middleware.
Those external interfaces are planned, not integrated.

## Delivered through Task 3

Strict TypeScript models, validated configuration, storage/messaging/runtime ports,
availability generation, atomic booking/rescheduling application operations,
cancellation and explicit lifecycle transitions, and pure checked-in queue ordering.
Tests include a test-only in-memory coordinator with rollback and overlap protection.
Task 3 adds a Worker entrypoint, clinic-scoped SQLite Durable Objects, operational
patients, audit, and a durable idempotent projection outbox. Google Sheets has a
port and schema, with no live adapter. No public HTTP operations, frontend, report
generator, WhatsApp, Meta, deployment, authentication, payments, or AI are included.

## Confirmed business rules

- Neutral demo defaults: demo_clinic, Demo Doctor, Specialist, Asia/Karachi, 20 minutes,
  30 clinic-local calendar dates (today through day 29), same-day allowed, active subscription.
- All records and operations use clinicId so clinics remain isolated.
- Working hours are configurable and unset. Test hours are explicitly synthetic.
- Availability subtracts breaks, blocked slots, and Scheduled/CheckedIn appointments
  using half-open interval overlap, and requires full duration within a working period.
- Starts must lie on a generated slot grid and be strictly in the future. There
  is no additional lead time or off-grid exception for walk-ins.
- Recheck authoritative availability within the final atomic write operation.
- Walk-ins use the same engine and can be checked in by a separate explicit operation.
- Only explicit clerk action marks NoShow; elapsed time never changes status.
- Early completion is allowed, with bookedAt <= checkedInAt <= completedAt where
  check-in exists. Planned start time does not constrain actual completion.
- Rescheduling retains and links the original and replacement, or changes neither.
- Patient and appointment records contain administrative data only, never clinical records.

## Ownership and SaaS direction

The clinic/doctor owns their phone number, patient and appointment records, and
exported data. InLoop owns and operates the appointment service, scheduling logic,
WhatsApp automation, queue logic, reporting engine, and subscription/access control.
The future product supports multiple clinics with monthly subscriptions. Active
subscription is required for availability/new bookings/rescheduling. Inactive and
suspended subscriptions still allow managing, reading, and exporting existing
records. Walk-in reservations are new bookings. No billing exists.

## Review before Task 4

Supply real working periods and breaks through runtime data, and review whether
future clinics need overnight hours, midnight endpoints, or DST-ambiguous slots.

The slot-grid, early-completion, and inactive-subscription policies are finalized.
Confirm trusted
clerk/doctor/patient actor permissions before exposing any input adapter, cancellation
or rescheduling cutoffs (none currently), and whether terminal-state corrections are needed.

The SQLite Durable Object adapter honors the atomic booking/rescheduling contract;
Google Sheets remains a projection. Local workerd tests cover concurrent reservations,
SQL rollback, object eviction, and retry. Review [operational concerns](persistence.md)
before live integration, especially authorization, request idempotency, capacity,
and the future Google receiver. Task 4 has not begun.
