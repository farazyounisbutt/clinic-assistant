# Architecture

One small, runtime-neutral TypeScript service owned and operated by InLoop. Task 2
implements scheduling, booking, rescheduling, lifecycle changes, and queue ordering.
There are no live integrations, HTTP endpoints, or production storage adapters.

```text
Future input adapter -> AppointmentService -> pure scheduling/lifecycle policies
                               |
                    AppointmentWriteCoordinator
                               |
                    future persistence adapter
```

## Boundaries

| Module         | Responsibility                                              |
| -------------- | ----------------------------------------------------------- |
| `clinic`       | Clinic settings and configuration/subscription validation   |
| `scheduling`   | Calendar/time conversion, interval validation, availability |
| `appointments` | Records, lifecycle policy, atomic application operations    |
| `patients`     | Administrative contact model                                |
| `queue`        | Pure clinic/date-scoped checked-in ordering                 |
| `reports`      | Reserved for future summaries                               |
| `ports`        | Storage, messaging, clock, and appointment-ID interfaces    |
| `adapters`     | Reserved external integration boundaries                    |
| `config`       | Validated settings from an injected environment map         |
| `shared`       | Common types and typed domain errors                        |
| `index.ts`     | Public exports for future composition                       |

`AppointmentService` receives an `AppointmentWriteCoordinator`, `Clock`, and
`AppointmentIdGenerator`. It exposes `availability`, `book`, `reschedule`,
`transition`, and `listAppointments`. The last operation returns existing records
for read/export consumers without subscription or booking-horizon restrictions. Displayed availability is never a reservation. `book` is the
application's create-if-available operation: it returns a committed appointment or
rejects with a typed error such as `DomainError` with code `SlotConflict`.

The domain imports no Node APIs, external SDKs, HTTP frameworks, or production
infrastructure. Core runtime dependencies remain zero. ESM/NodeNext compilation
supports Node; a future Worker entrypoint can compose the same modules.

## Atomic repository contract

`AppointmentWriteCoordinator.runExclusive(clinicId, operation)` must:

1. Serialize operations for a clinic across every writer and service instance.
2. Provide fresh clinic settings, working hours, blocked intervals, and appointments,
   plus read-your-writes inside the unit of work. Configuration/schedule changes
   affecting availability must use equivalent coordination.
3. Stage inserts/replacements without making partial changes visible externally.
4. Check the final staged state for overlapping Scheduled/CheckedIn records on the
   same clinic/date. Reject with `DomainError('SlotConflict')` if any overlap exists.
5. Commit all writes together, or leave all original state unchanged on any callback
   or commit failure. Resolve the operation only after successful commit.

The service reads its clock after acquiring the coordinator and loading fresh data.
It then performs the authoritative availability check and stages the appointment.
The adapter's final overlap check provides defense against any writer bypassing
that helper. A reschedule inserts the replacement before staging the original's
status change; both become visible together. Final-state validation permits a
replacement to overlap its own original, which becomes nonblocking at commit.

All reads/writes are clinic-scoped. Missing clinics/appointments and cross-clinic
writes must be rejected. Inserts reject duplicate IDs, replacements reject missing
IDs, and units of work cannot be used after their callback ends. Do not retry
callbacks implicitly or perform messaging or external side effects inside them.

Every future persistence adapter, including Google Sheets and PostgreSQL, must honor
this atomic booking/rescheduling contract. No implementation strategy for those
adapters is specified or implemented here.

The reference implementation in `tests/support/in-memory-store.ts` uses isolated
staging and per-clinic serialization to exercise the contract. It is test-only,
not durable, and does not coordinate separate store instances or processes.

## Validation and errors

Consumers branch on `DomainError.code`, never message text. Codes include
ClinicNotFound, InvalidClinicConfiguration, SubscriptionInactive,
DateOutsideBookingHorizon, SameDayBookingDisabled, ClinicClosed, SlotInPast,
SlotOutsideWorkingHours, SlotOffGrid, SlotOverlapsBreak, SlotBlocked, SlotConflict,
InvalidAppointmentTransition, AppointmentNotFound, InvalidReschedule, InvalidInput,
InvalidSchedule, and InvalidLocalTime.

Configuration, dates, times, schedule intervals, and booking contact/source values
are validated. Internal interfaces still are not arbitrary-JSON schemas. Future
input/storage adapters must allowlist fields and validate complete records.
Actor role is trusted internal context for the explicit clerk NoShow rule; no
identity authentication or general authorization system is implemented.

## Configuration and policy

`loadConfig(environment)` accepts an injected string map, without reading global
process state or files. Defaults are neutral demo values; working hours remain unset.
Appointment duration is a positive integer up to 1440 minutes; the horizon is a
positive integer count of local dates. A duration must also fit a working period.
Only active subscriptions allow availability queries, booking, and rescheduling.
Existing appointments can still be cancelled, checked in, completed, or marked
NoShow when the subscription is inactive or suspended. Reads and exports of existing
records remain available through `listAppointments` and storage read ports. New
WalkIn reservations are blocked just like other new bookings. This finalized policy
is independent of payment-provider logic.

See [availability rules](availability.md) and
[appointment lifecycle](appointment-lifecycle.md) for exact behavior.

Real clinic identity, doctor name, specialty, working hours, WhatsApp number, and
customer-specific settings belong in runtime clinic configuration/data. Repository
examples use demo_clinic, Demo Doctor, Specialist, and synthetic contact details.
