# Clerk WhatsApp operations

Clerks share the clinic's existing WhatsApp business number. The authenticated
webhook still selects the clinic from its receiving Phone Number ID; no sender or
command can choose a different clinic. No LLM or new Meta configuration is needed.
Doctor reporting is not implemented.

## Authorization

`OperatorDirectory` is a runtime-neutral, clinic-scoped lookup port returning an
internal operator ID and role. The POC adapter reads `WHATSAPP_OPERATORS`, an array
of `{clinicId, sender, operatorId, role}` records, from a runtime secret. `sender`
is the normalized WhatsApp sender identity (international digits, without `+`).
`operatorId` is a stable internal identifier, not a phone number. Roles are `Clerk`
and `Doctor`; only Clerk grants these operations. A future persistent directory
can supply the same lookup from authoritative local records.

No operators are enabled by default. Missing, malformed, duplicate or ambiguous
configuration grants no privileges. The adapter limits the list to 1,000 entries.
A sender may hold a different role in each clinic. Clinic A authorization never
grants access in Clinic B. Commands do not establish authorization, and responses
to unauthorized staff-like commands remain ordinary patient responses without
revealing staff membership. Doctor-only identities have no staff operations yet.

Authorization is resolved for every processed message, including recovered work.
The session records its clerk mode and operator ID. A role/operator change discards
incompatible state instead of reusing patient or clerk confirmation tokens. Queued
staff replies also recheck Clerk role and operator ID immediately before sending;
revoked access discards the reply as a configuration failure. Changes cannot retract
a reply already accepted by Meta or already in flight.

## Menu and state

An authorized clerk sending `menu`, `restart`, `staff`, `clerk`, `hi`, or `hello`
gets a deterministic six-row list:

- Today's Appointments
- Add Walk-in
- Check In Patient
- Mark Completed
- Mark No Show
- Block Time

Unknown/stale input safely redisplays the current prompt. A new session begins at
the clerk menu. Sessions expire after 30 minutes and persist in the existing
clinic-scoped `wa_conversations` table; a `kind: clerk` discriminator keeps them
separate from patient state. Only the current prompt and selections are retained.
There is no conversation-history store.

Each prompt has a fresh random action token. An action must be an option in the
current prompt. The existing `wamid` tombstone and atomic `runWithCommit` transaction
cover domain mutations, session replacement, inbox completion, and one outbound
reply. Duplicate webhook delivery produces no new effect. Repeated old buttons
with a new message ID may redisplay the current prompt but cannot repeat mutations.
Process restart preserves the inbox, session, outbox, and recovery alarm. Ambiguous
Meta sends remain unknown and are not automatically resent.

## Today's appointments and lifecycle

Today is determined using the runtime clinic timezone, not UTC or the server's
local date. All statuses are shown chronologically, then by appointment ID. Lists
show time, a truncated display name, status, source, and a short reference; selecting
a row shows the full reference and display name, never the phone number or note.
Lists page in groups of nine plus More. Cancelled and Rescheduled remain labeled.

Check-in and No Show lists include today's Scheduled records; completion includes
only today's CheckedIn records. Every selection is revalidated against the clinic,
local day, and eligible status at explicit confirmation. Midnight rollover requires
starting the operation again. The unchanged `AppointmentService.transition` enforces:

- Scheduled → CheckedIn, including before the scheduled start; records checkedInAt.
- CheckedIn → Completed, including early completion; completedAt ≥ checkedInAt.
- Scheduled → NoShow only after an explicit clerk selection and confirmation.

No time-based no-show transition is added. Each change records one activity with
the configured operator ID. Check-in reports queue position using the existing
checkedInAt, start time, appointment ID ordering. No patient is checked in implicitly.

## Walk-ins

The clerk enters a display name (at most 80 characters), chooses one of today's
currently generated available slots, enters an optional operational note (at most
160 characters), and confirms. Slots page in groups of nine. The final write calls
`AppointmentService.book` with source `WalkIn`; grid, future-start, same-day, horizon,
subscription, and conflict rules are unchanged. A lost slot returns fresh alternatives.
This POC therefore does not insert an arbitrary appointment starting immediately.

Walk-ins without a supplied contact use an empty `whatsappNumber`, permitted only
for source WalkIn. No fabricated phone number or clerk phone is used. A new patient
ID is allocated for each such reservation and projected to Patients. The patient
cannot look up a contactless walk-in via WhatsApp identity; staff manage it by
reference. All other booking sources still require the existing contact format.

After booking, Check In Now opens a separate explicit confirmation; Back to menu
leaves the appointment Scheduled. No new patient-facing mutation behavior is added.

## Block Time

The clerk enters a date (`YYYY-MM-DD`), start and end (`HH:mm`, same clinic-local
date), optional operational reason, then confirms. `BlockTimeService` validates and
inserts through the same serialized clinic unit of work. It requires:

- A future, unambiguous interval inside the clinic's booking horizon.
- Start before end, wholly inside one active working period and outside breaks.
- No overlap, including partial overlap, with Scheduled/CheckedIn appointments.
- No overlap with an existing block; no zero-duration, overnight, or DST-ambiguous
  interval. Blocks need not be appointment-sized; their overlap excludes slots.

Conflicts are rejected with a request to handle existing appointments separately.
No appointment is cancelled or rescheduled. Block Time is an operational configuration
mutation and remains allowed for inactive/suspended subscriptions, even where new
reservations or same-day bookings are disabled. It does not create a reservation.

The SQLite adapter stages the block and rejects duplicate IDs/cross-clinic writes.
The final transaction commits the block, `TimeBlocked` activity, revision, projection
outbox, inbox/session, and reply together. Commit failure leaves them all unchanged.
The block ID is included in the activity detail without the free-text reason.

## Subscription and projection

Inactive/suspended subscriptions block walk-in creation, including final confirmation
if the subscription changed during the conversation. Today's records, check-in,
completion, and explicit no-show remain available. Existing patient cancellation
and rescheduling policies are unchanged; no clerk cancellation/reschedule UI or
payment-provider logic is added in this milestone.

Appointments, Patients, Activity_Log, and Blocked_Slots use the existing immutable
full-snapshot projection outbox. A Sheets outage does not roll back authoritative
records or free occupied slots. Read-only menus queue no projection. Google Sheets
remains a projection and cannot authorize staff or decide availability.

## Privacy and live-test prerequisites

Use synthetic clinic and patient details during the POC. Notes are administrative
only, never medical history, diagnosis, prescriptions, or identity documents. Staff
menus omit contacts and notes; raw credentials, internal DO IDs, and external error
bodies are not displayed. Staff authorization secrets are never checked into source.
Staff prompts contain operational patient data and follow the existing 30-minute
session and terminal-outbox cleanup rules. Phone identity reassignment, shared staff
phones, and revocation need operational review before real clinic use.

Before a separately authorized deployment/live test:

1. Review a minimal clinic-scoped Clerk assignment and provision it as a secret;
   keep a separate ordinary patient test identity to verify isolation.
2. Confirm synthetic runtime clinic hours, timezone, subscription, and Sheets target.
3. Run the full test suite, coverage, checks, build, dry-run, and credential scan.
4. Exercise each clerk action with explicit confirmation, role revocation, stale
   buttons, lost slots, blocked-time overlap, and projection recovery.
5. Verify the scheduled patient workflow still works from the ordinary test identity.

This milestone neither deploys automatically nor adds Doctor reports, reminders,
LLMs, clinical records, billing, staff-management UI, or multi-doctor scheduling.
