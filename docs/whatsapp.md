# WhatsApp patient conversations (Task 5)

This adapter adds patient booking, lookup, cancellation, and rescheduling to the
WhatsApp-first clinic appointment and queue management service. There are no
clerk/doctor commands, templates, reminders, reports, billing, or AI. Nothing in
this task provisions a Meta app or deploys a Worker.

## Boundary and routing

The only public route is `/webhooks/whatsapp`:

- `GET`: requires `hub.mode=subscribe`, the configured `hub.verify_token`, and a
  nonempty `hub.challenge`. Returns the challenge as plain text. Wrong/missing
  values return 403. Other paths return 404; unsupported methods return 405.
- `POST`: reads at most 256 KiB, authenticates the **original bytes** using
  HMAC-SHA256 and `X-Hub-Signature-256` via Web Crypto, then validates the envelope.
  Invalid signatures return 403. Malformed payloads, excessive batches (over 100
  recognized events), or unknown receiving phone IDs return 400. Missing server
  configuration or failed durable writes return 503.
- `value.metadata.phone_number_id` resolves through `WHATSAPP_PHONE_CLINICS` to a
  named clinic Durable Object. Patient identity is never used for clinic routing.
  All routes in a batch are validated before enqueue starts. A partial multi-clinic
  persistence failure returns 503; Meta can retry, and already stored IDs deduplicate.
- A 200 response follows **durable inbox/status persistence**, including alarm
  registration. `waitUntil` starts processing; an alarm recovers work after a
  restart. Conversation handling, Meta sends, and Google HTTP are outside the
  acknowledgment path. Meta and Sheets delivery use independent durable queues.

Internal RPC remains a trusted service boundary, not a public management API.
No webhook can supply a clerk/doctor role. Cancel/reschedule selections are checked
against the sender's records in the current clinic, again at final mutation time.

The parser allows text, interactive button replies, and interactive list replies.
Profile names, media, context, and unrelated webhook fields are discarded.
Unsupported messages prompt recovery; text longer than 160 characters is treated
as unsupported. Delivery events never become conversation input.

## Runtime configuration

Set these only through ignored local `.dev.vars` or Cloudflare secrets/configuration:

| Variable                 | Purpose                                                        |
| ------------------------ | -------------------------------------------------------------- |
| `META_ACCESS_TOKEN`      | Access token authorized to send WhatsApp messages              |
| `META_APP_SECRET`        | App secret for POST signature verification                     |
| `WHATSAPP_VERIFY_TOKEN`  | Independently chosen webhook verification token                |
| `WHATSAPP_PHONE_CLINICS` | JSON mapping `"<WHATSAPP_PHONE_NUMBER_ID>"` to `"demo_clinic"` |
| `WHATSAPP_GRAPH_VERSION` | Graph API version; application default `v25.0`                 |

`v25.0` is the version targeted by the transport fixtures, not an assertion that
it is the latest version. Check Meta's current version support before live testing
or changing the override. Invalid version syntax fails closed. WABA ID is needed
for eventual app subscription/setup, but not for this adapter's runtime routing or
message sending, so it is not stored by this application.

Provision clinic settings/hours through the existing trusted configuration boundary.
Doctor display name, specialty, timezone, schedule, and subscription state come from
that clinic's persisted configuration. There is no customer-specific default here.
Multiple phone IDs may map to one clinic; sessions and patient ownership are shared
within that clinic. Each reply uses the receiving phone ID of its incoming message.

## Conversation state machine

A clinic-scoped session is keyed by the WhatsApp sender identity. It stores the
workflow/step, selected date/time, reusable patient ID/name, optional administrative
note, relevant appointment ID, last interaction time, revision, and the current
prompt/options. It retains **one current state**, not chat history. A session expires
after 30 minutes of inactivity; `hi`, `hello`, `menu`, and `restart` reset the workflow.
Buttons/lists include a fresh random state token. An old button, even delivered
under a different `wamid`, cannot confirm a later workflow or mutate another record.

```mermaid
stateDiagram-v2
  Menu --> Dates: Book Appointment
  Dates --> Times: choose date
  Times --> Name: no reusable name
  Times --> Note: reusable name
  Name --> Note
  Note --> Confirm: optional note or Skip
  Confirm --> Menu: Confirm / Cancel
  Confirm --> Dates: Change date
  Confirm --> Name: Correct name
  Menu --> Upcoming: My Appointment / Manage Appointment
  Upcoming --> Menu: view
  Upcoming --> Manage: select owned Scheduled appointment
  Manage --> CancelConfirm: Cancel
  CancelConfirm --> Menu: confirm cancellation / keep
  Manage --> Dates: Reschedule
  Times --> Confirm: rescheduling
```

- Three initial reply buttons: Book Appointment, My Appointment, Manage Appointment.
- Dates are clinic-local and generated through the existing scheduling engine;
  only dates with availability are shown (nearest nine plus a next-page choice).
  Each query scans at most 30 dates, so long configured horizons remain bounded.
  More dates advances within the configured horizon, including past empty pages.
  Times are fetched again when selecting a date. Lists contain up to nine times or
  appointments plus a next-page choice. Displayed times are **not reservations**.
- Name comes from a matching patient record if available; otherwise it is requested
  (80 characters maximum). Confirmation → Change → Patient name supports correction.
  A successful new booking updates the reusable patient record through existing policy.
- The note is optional, with an explicit Skip button. Copy asks for administrative
  information only, never diagnosis, history, prescriptions, or identity documents.
  This deterministic POC does not attempt to classify clinical text; operators must
  review privacy handling before inviting real patients.
- Confirmation shows the configured doctor, timezone, date/time, name, and optional
  note. Confirm calls the authoritative appointment service with source WhatsApp.
  If the slot has gone, no booking is created and fresh alternatives are displayed.
- Lookup shows only the sender's future Scheduled/CheckedIn records, with pagination.
  Management requires a future Scheduled record. Cancellation has a separate
  confirmation. Rescheduling atomically creates a linked replacement and preserves
  the original if final validation fails. Reschedule availability excludes only
  the selected original's interval, using the same domain engine.
- Suspended/inactive subscriptions block new bookings and rescheduling, including
  final confirmation after a subscription change. Existing lookup/cancellation
  remains available. This is existing domain policy, not payment-provider logic.
- Unknown/stale input redisplays the current options and a recovery instruction.
  Configuration changes that invalidate a selection return to the menu safely.

## Atomic processing and idempotency

`wa_inbox` has a unique incoming message ID and arrival sequence. Duplicate webhook
messages neither advance the session nor create another outbound response. It
survives actual DO eviction. A storage-scoped messaging lock serializes drains;
the shared repository write lock serializes conversation reads and final domain work
with other clinic writers. No network call occurs while holding the write lock.

`runWithCommit` stages domain operations using the existing unit of work. In one
storage transaction it commits:

1. appointment/patient changes, audit events, and the existing Sheets projection job;
2. the new conversation state;
3. clearing the inbound payload to an idempotency tombstone;
4. the outbound reply, keyed by that same incoming ID.

Any failure rolls all four back. Steps without domain changes do not bump the
projection revision or generate Sheets snapshots. Infrastructure processing failures
retain incoming work and retry after 30 seconds, doubling to at most one hour.
Arrival order is preserved; a failing head blocks later clinic inbox work until
recovered. Domain failures are handled as conversation responses, not retry loops.

Inbound payloads are removed after processing. The minimal message-ID tombstone is
retained indefinitely in this POC to prevent old replay after a restart; it contains
no sender or message text. Review capacity and a documented replay/retention window
before a long-running production launch. Incoming messages older than 24 hours or
more than five minutes in the future become tombstones without conversation effects.

## Outbound delivery and status

The Worker-compatible client posts to
`https://graph.facebook.com/{version}/{phone-number-id}/messages`, with bearer
authorization in a header, a ten-second timeout, and redirects disabled. It supports
plain text, up to three reply buttons, and lists with at most ten rows; it validates
message and option lengths. It uses no SDK or runtime package dependency.

`wa_outbox` persists a claim **before** sending. A successful response records the
Meta message ID. Delivery statuses (sent/delivered/read/failed) update only matching
phone ID, recipient, and outbound provider ID. Read/delivered statuses do not regress
because of out-of-order events. Early status callbacks can wait in a 24-hour status
buffer until the send result is committed.

| Outcome                                     | Behavior                                                                                         |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 400-class rejection                         | Failed; no automatic retry                                                                       |
| 401/403                                     | Authentication failure; no automatic retry                                                       |
| 429                                         | At most three total attempts, exponential backoff, respecting numeric Retry-After up to one hour |
| 5xx, network, timeout, invalid success body | Outcome unknown; no automatic resend                                                             |
| Crash after send claim                      | Outcome unknown on recovery; no automatic resend                                                 |
| Missing/invalid configuration               | Failed; no automatic retry                                                                       |

Exactly-once delivery cannot be guaranteed across a network request and local commit.
This POC favors avoiding duplicate sends: a response can be lost after a crash or
ambiguous failure even though the booking succeeded. The patient can send `menu`
and use My Appointment. Operational errors store only typed categories, not Meta
response bodies, bearer tokens, raw payloads, or patient text. Outbound bodies are
cleared after a terminal result; operational rows expire after seven days.

No freeform response is sent after the originating user message's 24-hour window.
Only user-initiated messages are supported; this task does not create templates.
Pending 429 responses preserve recipient order without blocking other recipients.
Each drain is bounded by count and elapsed time; the earliest queue/cleanup deadline
shares the DO alarm with Sheets, so one queue cannot erase the other's wakeup.

## Local verification and eventual live testing

Run `npm run check`, `npm run test:coverage`, and `npm run build`. Build performs
TypeScript compilation plus a Wrangler Worker dry-run; it does not deploy.
`npm test -- tests/whatsapp` runs transport and real local DO SQLite tests with fake
Meta HTTP, deterministic clocks, synthetic identifiers, transaction-failure injection,
and DO eviction. Normal test bindings override all Google and Meta secrets with
empty values, even when local `.dev.vars` exists.

Before a separately authorized live session:

- Review Meta app permissions/token lifetime, phone registration, WABA app subscription,
  callback URL, webhook verification token, and app secret. Use a test number first.
- Review the configured Graph version against Meta's current supported versions.
- Set the phone-to-clinic mapping and synthetic runtime clinic configuration; verify
  signature checks through the actual HTTPS callback without logging payloads.
- Exercise booking, duplicate delivery, cancellation, rescheduling, status updates,
  token expiry, and a timeout. Check that actual device buttons/lists match fixtures.
- Review consent, privacy/retention, access control for operational data, phone-number
  reassignment, and how support investigates unknown sends. No patient authentication
  beyond the authenticated WhatsApp sender identity is added in this POC.
- Inspect pending/failed/unknown inbox/outbox operations through trusted storage tooling;
  no public diagnostics or automated replay endpoint is exposed.

Protocol references: [Meta webhook setup](https://developers.facebook.com/docs/graph-api/webhooks/getting-started/),
[Meta interactive payload examples](https://whatsapp.github.io/WhatsApp-Nodejs-SDK/api-reference/messages/interactive/),
and [Graph API version history](https://developers.facebook.com/docs/graph-api/changelog/versions/).
The example SDK documentation is archived; this implementation uses direct HTTP,
not the archived SDK. Verify current Meta requirements again before live setup.
