# Google Sheets operational projection — schema v1

SQLite in the clinic Durable Object is authoritative. Google Sheets is a clinic-facing
operational/export projection. No spreadsheet, Google account, or credentials are
created by this milestone. [Task 4 delivery](google-sheets.md) adds explicit bootstrap
of an already-created empty target, plus a spreadsheet-level version/clinic/revision
marker. The v1 columns below are unchanged. The exact ordered headers are defined by `SHEET_COLUMNS`
in `src/projection/sheets.ts`; the tables below list that same order.

Every sheet starts with these three columns:

| Column     | Meaning                                                                 |
| ---------- | ----------------------------------------------------------------------- |
| Record_Key | Stable logical row key, scoped to clinic and sheet; never a row number. |
| Revision   | Integer clinic snapshot revision, used for delivery ordering/recovery.  |
| Clinic_ID  | Opaque runtime clinic ID, e.g. `demo_clinic`.                           |

`ClinicProjectionSnapshot` also carries schemaVersion=1, clinicId, and revision.
Cells are strings, numbers, booleans, or null. The Google REST adapter renders null as an
empty cell; booleans remain booleans and numeric settings remain numbers. IDs,
phone numbers, dates, times, timestamps, JSON, and free text must be written as RAW
text, never interpreted as formulas or auto-converted numbers. Date/time cells use
clinic-local YYYY-MM-DD/HH:mm; event timestamps are UTC ISO strings ending in Z.

## Clinic_Settings

One row, keyed by Clinic_ID. After the three common columns:

| Column                       | Meaning                                                       |
| ---------------------------- | ------------------------------------------------------------- |
| Doctor_Name                  | Runtime configured display name; neutral example Demo Doctor. |
| Specialty                    | Runtime configured specialty; neutral example Specialist.     |
| Timezone                     | IANA timezone used by scheduling.                             |
| Appointment_Duration_Minutes | Positive integer duration.                                    |
| Booking_Horizon_Days         | Positive count of clinic-local dates, including today.        |
| Same_Day_Booking_Allowed     | Boolean policy.                                               |
| Subscription_Status          | active, inactive, or suspended; domain/application policy.    |

## Working_Hours

One row per working period; key `Day:Start:End`, e.g. `1:09:00:10:00` for synthetic
Monday test hours. Changing a period's endpoints changes its key; the next full
snapshot removes the obsolete row. After the common columns:

| Column      | Meaning                                                        |
| ----------- | -------------------------------------------------------------- |
| Day         | ISO weekday 1 (Monday) through 7 (Sunday).                     |
| Active      | Boolean; false contributes no availability.                    |
| Start       | Inclusive local period start.                                  |
| End         | Exclusive local period end.                                    |
| Breaks_JSON | Array of `{startTime,endTime}` objects; empty array when none. |

Breaks are normalized to start/end objects within their parent period. No real
working hours are seeded. Overnight periods remain unsupported by the domain.

## Blocked_Slots

One row per Block_ID. After the common columns:

| Column   | Meaning                                      |
| -------- | -------------------------------------------- |
| Block_ID | Stable blocked interval ID, also Record_Key. |
| Date     | Clinic-local blocked date.                   |
| Start    | Inclusive local start.                       |
| End      | Exclusive local end.                         |
| Reason   | Administrative unavailability label only.    |

## Appointments

One row per Appointment_ID, including terminal and rescheduled records. After the
common columns:

| Column           | Meaning                                                                      |
| ---------------- | ---------------------------------------------------------------------------- |
| Appointment_ID   | Stable appointment ID, also Record_Key.                                      |
| Patient_ID       | Clinic-scoped patient reference.                                             |
| Patient_Name     | Booking-time administrative name snapshot.                                   |
| WhatsApp_Number  | Booking-time E.164-shaped contact snapshot, stored as text.                  |
| Date             | Clinic-local planned appointment date.                                       |
| Start            | Planned inclusive start.                                                     |
| End              | Planned exclusive end.                                                       |
| Reason           | Optional administrative booking note; null when absent, never clinical data. |
| Source           | WhatsApp, WalkIn, Clerk, or Phone.                                           |
| Status           | Scheduled, CheckedIn, Completed, NoShow, Cancelled, or Rescheduled.          |
| Booked_At        | UTC booking timestamp; also available to queue ordering.                     |
| Checked_In_At    | Nullable UTC arrival timestamp, used for queue ordering.                     |
| Completed_At     | Nullable UTC completion timestamp; may precede planned start.                |
| Cancelled_At     | Nullable UTC cancellation timestamp.                                         |
| Rescheduled_From | Nullable original appointment ID.                                            |
| Rescheduled_To   | Nullable replacement appointment ID.                                         |
| Created_By       | Internal actor ID that created this appointment.                             |

NoShow time and transition actors are in Activity_Log; reading a row never changes
its status. Rescheduling retains the old row and creates a distinct linked row.

## Patients

One row per Patient_ID. After the common columns:

| Column          | Meaning                                           |
| --------------- | ------------------------------------------------- |
| Patient_ID      | Stable clinic-scoped patient ID, also Record_Key. |
| Name            | Current administrative name from a fresh booking. |
| WhatsApp_Number | Current appointment contact number, as text.      |
| Created_At      | UTC timestamp of first contact creation.          |

No diagnosis, prescription, CNIC, medical history, or medical records are stored.
Updating a patient contact never edits historical appointment snapshots.

## Activity_Log

One row per Event_ID. After the common columns:

| Column         | Meaning                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------ |
| Event_ID       | Stable `revision:sequence` event identifier, also Record_Key.                                          |
| Timestamp      | UTC timestamp of authoritative mutation.                                                               |
| Actor_ID       | Trusted internal actor identifier, not a display name or credential.                                   |
| Action         | ConfigurationUpdated or appointment creation/lifecycle action.                                         |
| Appointment_ID | Related appointment ID; null for configuration events.                                                 |
| Detail         | Operational status/link JSON or configuration replacement label; no contact or external error payload. |

## Delivery, manual edits, and ownership

The receiver upserts by `(Clinic_ID, sheet, Record_Key)` and removes obsolete
managed keys for that clinic. Repeated application of the same revision must have
no additional effect. An older revision must never overwrite a newer completed
revision. Actual sheet row numbers are only adapter bookkeeping and can change
when rows are sorted. Rebuild the key index when necessary; never blindly append.
Apply all sheets before acknowledging. On partial failure retry the whole immutable
snapshot and converge to the same logical records. [Persistence](persistence.md)
describes the durable outbox, ordering, alarms, and acknowledgement-loss behavior.

System-managed appointment data should be protected/read-only for clinic staff
where practical. Direct edits cannot affect booking availability and may be
replaced by the next projection. Clinic staff must use a controlled application
operation for cancellation, rescheduling, and lifecycle changes. A future working
hours import must validate and commit through the same Durable Object boundary.
There is no arbitrary bidirectional synchronization. The clinic owns its data;
inactive subscriptions retain access to existing records and exports.
