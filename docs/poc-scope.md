# POC scope

WhatsApp-first clinic appointment and queue management service.

Patients will use WhatsApp, clerks will use WhatsApp and Google Sheets, and doctors
will receive WhatsApp summaries. InLoop operates the middleware. These are planned
interfaces, not integrations delivered in this foundation.

## Foundation delivered

Strict TypeScript models, lifecycle policy, clinic-scoped repository and messaging
ports, configuration parsing, unit tests, and developer tooling. There is no running
HTTP service, persistent storage, frontend, booking workflow, queue engine, or report
generator yet. No WhatsApp, Meta, Google Sheets, production Cloudflare, payment,
or credential integration is included.

## Agreed business rules

- Initially one doctor; always carry `clinicId` internally for future clinics.
- demo defaults: `demo_clinic`, Demo Doctor, Specialist, `Asia/Karachi`, 20-minute
  appointments, 30-day booking horizon, same-day booking allowed, subscription active.
- Working hours and breaks remain configurable and unset. Do not infer the doctor's
  real schedule. Until configured, a future availability service must offer no slots.
- Availability = working hours minus breaks, blocked slots, and active appointments.
- Recheck availability immediately before confirmation, inside coordinated writes.
- Walk-ins use the same appointment records and lifecycle as WhatsApp bookings.
- A clerk explicitly marks No Show; elapsed appointment time never does so automatically.
- Rescheduling preserves the original record and creates a linked replacement.
- Store administrative contact and appointment data only, never clinical records.

## Ownership and SaaS direction

The clinic/doctor owns their phone number, patient and appointment records, and
exported data. InLoop owns and operates the appointment service, scheduling logic,
WhatsApp automation, queue logic, reporting engine, and subscription/access control.
The future product supports multiple clinics with monthly subscriptions.
`subscriptionStatus` is modeled now; billing, payments, subscription enforcement,
authentication, and authorization are future work.

## Decisions needed before Task 2

Confirm actual working hours and breaks, holiday/blocked-slot editing, booking
horizon inclusivity, past-time handling for same-day bookings, overnight hours,
clerk identity and permissions, and queue ordering for walk-ins. Confirm cancellation
and rescheduling cutoffs, whether terminal-state corrections are needed, and the
subscription-state vocabulary/access policy. Choose the Sheets write coordination,
recovery, and clerk-edit strategy before implementing booking confirmation.
