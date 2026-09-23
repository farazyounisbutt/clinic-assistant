# Read-only Doctor's View

Task 2A uses the existing WhatsApp routing and clinic-scoped operator directory.
A Doctor must be explicitly configured as role `Doctor` in `WHATSAPP_OPERATORS`.
No command grants access, and Doctor does not imply Clerk permissions. No live
operator mapping is changed by this implementation.

The Doctor menu provides:

- Today's Appointments: clinic-local date, AM/PM time, patient name and status.
- Waiting Queue: existing checked-in ordering (arrival, scheduled start, UUID),
  highlighting the next patient. Selecting a row shows read-only details.
- Daily Summary: an operational total counting Scheduled, Checked In, Completed
  and No Show appointments for today, with individual status counts. Cancelled and
  Rescheduled counts appear separately and are excluded from the operational total.

Lists use nine rows plus More. Details omit raw appointment UUIDs, contacts and
administrative notes. UUIDs remain internal for appointment identity, actions and
authorization.
Empty days and queues have explicit messages. Use `menu` or `doctor` to return to
the menu. Sessions expire after 30 minutes, use state-bound action tokens and
persist through the existing conversation store. Commands only navigate an
already authorized role. Role changes discard incompatible sessions.

Appointment reads use the current clinic and its configured timezone, without
subscription or booking-horizon restrictions. The Doctor flow receives only clinic
settings and an appointment-read capability. It cannot book, reschedule, cancel,
check in, complete, mark no-show or block time. It changes only messaging/session
state, never appointment records, patients, audit events or projection revisions.

Authorization is checked for each inbound action and again before sending a queued
staff reply, matching both operator ID and role. Existing queued Clerk replies
without a role field retain their original Clerk-only policy. No schema migration,
new dependency, clinical records or Doctor mutation functionality is introduced.
