# Clinic persistence and recovery

Task 3 added a Cloudflare Worker and SQLite-backed Durable Object adapter. Task 4
connects its outbox to the Google REST projection adapter and adds delivery diagnostics. No live
service is connected. `npm run build` bundles the Worker with `--dry-run` and does
not deploy. `wrangler.jsonc` declares the `CLINICS` binding and migration `v1` with
`new_sqlite_classes: ["ClinicDurableObject"]`. Public HTTP requests return 404.

## Coordination

A trusted future input adapter selects `env.CLINICS.getByName(clinicId)`. Never use
random object IDs, appointment IDs, or patient IDs for routing. Each RPC validates
that `idFromName(clinicId)` equals its own object ID. SQLite metadata additionally
binds a database to its clinic. Separate clinics can reserve identical times.

Internal RPC methods are `configure`, `book`, `reschedule`, `transition`,
`availability`, `appointments`, `exportRecords`, and `projectionStatus`. Task 4
adds internal `bootstrapProjection`, `validateProjection`, and `drainProjection`
operations (see [delivery setup](google-sheets.md)). Results
are `{ok:true,value}` or `{ok:false,error:{code,message}}`, preserving domain error
codes across RPC. Unexpected storage failures expose a generic error. Actor IDs
and roles are trusted internal context; these methods are not an authentication
boundary. No public input or live integration is enabled.

`SqliteClinicRepository` implements `AppointmentWriteCoordinator` and
`AppointmentRepository`. A storage-scoped promise mutex serializes configuration
and appointment mutations, including across repository instances in the same DO.
The DO supplies the cross-request and distributed clinic boundary; a JavaScript
mutex alone would not coordinate different processes.

Each callback sees a fresh snapshot plus staged changes. Duplicate insert IDs,
missing replacements, and cross-clinic operations fail. The unit closes after its
callback; no automatic callback retries occur. Before commit, every pair of active
appointments on the same date is checked for overlap. A single SQLite transaction
then writes appointments, patient contacts, audit events, revision, immutable
projection snapshot, and recovery alarm. Any SQL failure rolls the transaction
back. A successful booking is acknowledged only after that transaction resolves.
No external operation runs inside the authoritative transaction.

Configuration updates use the same mutex, validate intervals and clinic scope,
and replace the complete schedule. Existing appointments are retained even if a
new schedule excludes their times; they continue to reserve their original times.
Changing working hours never silently reschedules patients. Booking policy remains
in the existing application/domain, including slot grid, walk-ins, early completion,
and subscription restrictions. Existing-record reads and exports need no active
subscription. Repository interfaces are trusted internal APIs, not arbitrary JSON
import interfaces. Persisted configuration and appointment properties are allowlisted.

## SQLite schema version 1

| Table               | Key and stored content                                                                                                                               |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `metadata`          | Singleton 1; schema_version=1, clinic_id, monotonically increasing revision, delivered_revision. A different clinic or unknown version fails closed. |
| `clinic_settings`   | Clinic ID; JSON of the eight Clinic fields.                                                                                                          |
| `working_hours`     | `dayOfWeek:startTime:endTime`; JSON period, active flag, clinicId, and normalized breaks array of start/end objects.                                 |
| `blocked_slots`     | Block ID; JSON clinicId, date, start/end, administrative reason.                                                                                     |
| `patients`          | Patient ID; JSON clinicId, name, WhatsApp number, createdAt.                                                                                         |
| `appointments`      | Appointment ID; full operational domain JSON. Generated date/start/end/status columns; `(date,start,id)` index for date reads.                       |
| `activity_log`      | `revision:sequence`; JSON eventId, clinicId, timestamp, actorId, action, appointmentId (nullable), detail.                                           |
| `projection_outbox` | Revision; immutable schema-v1 snapshot JSON, attempts, next_attempt_at (epoch milliseconds), last_error (nullable safe classification).              |

The record tables use primary keys and `json_valid` constraints. SQL parameters
bind all data; table names come from a fixed internal allowlist. Breaks are nested
in their working period because they share its lifecycle. JSON records keep this
POC schema aligned with the small domain model; migrations must be explicit when
that model changes. Migration runs in a synchronous transaction before use.

A fresh booking creates or updates the nonclinical patient contact and preserves
its original creation timestamp. Appointment contacts remain booking-time snapshots.
Rescheduling copies that historical contact into the linked replacement without
rewriting the current patient contact. There is no independent patient editing API.

Audit actions include `ConfigurationUpdated`, `AppointmentCreated`,
`AppointmentCheckedIn`, `AppointmentCompleted`, `AppointmentCancelled`,
`AppointmentNoShow`, and `AppointmentRescheduled`. Rescheduling records both the
replacement creation and the original's status/link update. Details contain statuses
and linkage, not patient names, contact numbers, reasons, or external error text.
Configuration audit records replacement, not a full before/after configuration diff.

## Projection outbox and failures

Each successful mutation increments the revision and queues a full immutable clinic
snapshot in the same transaction. Read-only operations and rejected mutations queue
nothing. Snapshots include all six [managed sheets](sheets-schema.md), including
stable record keys and revisions. Removing a working period or block is represented
by its absence from the next snapshot.

After commit, the DO uses `waitUntil` to attempt projection through the
`ClinicRecordProjection` port. A separate mutex serializes projection drains without
holding the booking mutex while waiting for the external system. Outbox jobs are
processed in revision order, up to 25 per invocation with an elapsed-time budget. Success deletes that job and
advances delivered_revision in a transaction. Failure retains the immutable snapshot,
increments attempts, and stores a classified safe error, never the external response body.
Transient retries use 30-second exponential backoff capped at one hour. Task 4
adds Retry-After support, a delay after uncertain writes, and a 24-hour slow probe
for permanent/configuration failures. The oldest pending
job blocks later delivery to preserve order. Pending includes both unattempted and
failed jobs; failed counts jobs with a recorded failed attempt.

The recovery alarm is registered transactionally with new work. Drain completion
reschedules the alarm for the oldest pending job, or removes it when empty. Alarm
execution failures also receive Cloudflare's runtime retry behavior. If a process
ends after delivery but before local acknowledgement, the same snapshot is retried.
The receiver must converge by stable keys and ignore stale revisions. Sheets may
be stale or partially projected during an outage; SQLite alone decides availability.
A Sheets failure never rolls back a successfully reserved appointment.

Task 4 composes the real Google REST adapter from runtime service-account secrets
and a clinic-to-spreadsheet target map. Missing configuration is a safe pending
failure, not a booking error. See [Google delivery](google-sheets.md) for bootstrap,
revision-safe batch writes, error categories, timeouts, and partial/uncertain recovery.
No live credentials or Google account are connected by this repository.

## Limits before a live connection

- Full snapshots and full-clinic staging are simple but grow with clinic history;
  a prolonged outage multiplies storage usage. Define retention, backlog alerts,
  capacity limits, and eventually snapshot compaction or incremental delivery.
- Final overlap verification is quadratic in active records. Establish clinic-size
  limits and measure before optimizing date-scoped validation.
- Add authenticated actor and clinic authorization, request payload validation and
  size limits before enabling HTTP or messaging input. API request idempotency is
  distinct from projection idempotency and is not yet implemented.
- Choose backup/restore procedures and test schema upgrades, disaster recovery,
  migration rollouts, and Cloudflare operational limits before a live launch.
- Task 4 implements literal text writes, stable-key/revision handling, bounded HTTP
  requests, and slow retries for configuration failures. Set up protected ranges,
  operational alerts, credential rotation, and live receiver validation before launch.

Tests use the official Cloudflare Vitest plugin and real local workerd SQLite,
including SQL-trigger fault injection and actual Durable Object eviction. The
original 201 domain tests are preserved. No mocked database substitutes for SQLite.

References: [SQLite storage transactions](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/),
[Durable Object tests](https://developers.cloudflare.com/durable-objects/examples/testing-with-durable-objects/),
[Cloudflare Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/).

Task 4 adds an additive delivery migration: outbox `created_at` plus a
`projection_delivery` singleton for migration version, cumulative failures, and
last safe error/time. No domain record or projection column is removed. Existing
Task 3 outbox snapshots and retry deadlines survive migration.
