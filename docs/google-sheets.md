# Google Sheets projection delivery

Task 4 implements the Google REST adapter without connecting an account, creating
a spreadsheet, or deploying infrastructure. SQLite in one named Durable Object
per clinic remains the booking authority. Google reads are used only to validate
and reconcile projection output; they never enter the scheduling engine.

## Service-account setup model

InLoop owns one Google service account. Enable the Google Sheets API in its Google
Cloud project and create the service account. A clinic manually creates a new,
empty spreadsheet and shares that spreadsheet with the service-account email as
Editor. No Google Drive API, domain-wide delegation, or user impersonation is used.
The clinic retains ownership of its spreadsheet. No domain-wide role is needed.

Supply these runtime inputs (never commit their values):

| Input                              | Purpose                                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------ |
| GOOGLE_SERVICE_ACCOUNT_EMAIL       | Service account client email.                                                  |
| GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY | PKCS#8 PEM private key; actual newlines or literal escaped `\n` are supported. |
| GOOGLE_SHEETS_TARGETS              | JSON object mapping each clinic ID to its spreadsheet ID.                      |

For local `wrangler dev`, place values in ignored `.dev.vars`. `.env.example` lists
empty placeholders only; the application does not automatically read a `.env` file.
For a future deployed Worker, use Cloudflare secret bindings, such as interactive
`wrangler secret put GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`. Never put secret values
in shell arguments, logs, source, Wrangler configuration, or fixtures. Store and
rotate the downloaded service-account key using an approved secret store; do not
copy its JSON file into this repository. No deployment is performed in this task.

The target mapping is trusted runtime configuration, not a parameter on a booking
or bootstrap request. Duplicate spreadsheet IDs across clinics are rejected. Each
spreadsheet also has a clinic marker, preventing a mapping mistake from sending
one clinic's data to a spreadsheet initialized for another clinic.

Authentication uses a narrowly scoped JWT bearer grant: RS256 signing is performed
by Web Crypto using an imported PKCS#8 key, with a fixed Google token endpoint and
Sheets-only OAuth scope. No `sub` claim or custom cryptographic algorithm is used.
Tokens are cached per object instance until 60 seconds before expiration. Concurrent
acquisitions share one request; eviction naturally clears the cache. A Sheets 401
invalidates the cached token and allows one refresh/retry, then becomes a typed
failure. Key parsing/signing failures return a fixed safe message.

## Explicit bootstrap and validation

The spreadsheet must already exist; this service does not create the file. From a
trusted internal Worker binding or local workerd harness, invoke:

```ts
const clinic = env.CLINICS.getByName(clinicId);
const result = await clinic.bootstrapProjection(clinicId);
// Check result.ok and the safe result.error if false.
const validation = await clinic.validateProjection(clinicId);
```

These are internal Durable Object RPC operations. Public HTTP requests still return
404; there is no unauthenticated administration endpoint or public booking API.
Bootstrap never runs implicitly during a booking, alarm, or normal projection.

Bootstrap reads every existing tab and refuses nonempty cells, incompatible metadata,
or unsupported sheet structures. Empty existing tabs are retained. Missing managed
tabs are added, exact v1 headers are written, and a spreadsheet-level developer
metadata marker is created in one batch. An existing compatible marker triggers
validation only, making repeated bootstrap safe. It never replaces an incompatible
header or deletes an existing tab. Perform bootstrap only while no person or other
client is editing the new spreadsheet.

The developer metadata key `clinic_assistant_projection` has DOCUMENT visibility
and spreadsheet location. Its value is JSON containing `schemaVersion: 1`, `clinicId`,
and `revision` (initially 0). Normal delivery requires exactly one such marker,
the correct clinic/version, all six managed tabs, and exact ordered headers. The
[initial column schema](sheets-schema.md) is unchanged. Missing metadata on an old
manually prepared spreadsheet requires operator review, not automatic adoption.

## Stable keys, revisions, and batch updates

Normal delivery reads the managed tables and builds a key-to-row index on every
attempt. This tolerates sorting. Existing keys update their current rows; new keys
occupy empty/vacated rows or newly expanded grid rows. Missing keys in a newer full
snapshot clear only managed cell values. No blind append is used, including for
Activity_Log. Appointment, patient, block, and event keys remain their stable IDs;
settings and working periods retain the Task 3 keys.

Each attempt checks row revisions and the spreadsheet revision. A snapshot older
than or equal to the last fully applied revision is a no-op. A row newer than the
spreadsheet marker is treated as inconsistent schema and blocked from normal
writes. Foreign-clinic rows, duplicate keys, wrong headers, or malformed records
also fail safely. An unexpected unmanaged tab is untouched by normal delivery.

One `spreadsheets.batchUpdate` contains the cell updates, any required row expansion,
and revision-marker update. Strings use `userEnteredValue.stringValue` so phone
numbers, dates, and formula-looking text remain literal. Nulls clear values. Header
order and schema version are unchanged. Batch payloads over 1.8 MB remain pending
as malformed/oversized payloads; they are never silently split across a revision.
Google's batch applies the projection changes together; the appointment transaction
has already committed independently in SQLite.

The sole authorized writer is the clinic Durable Object, whose projection mutex
also serializes bootstrap and validation. The Sheets API does not provide a
compare-and-swap revision precondition across a read and write. Revision guarantees
therefore require this single writer and no external edits or competing deployment
writing the same target. Do not invoke the adapter concurrently from separate
Workers or bypass the Durable Object.

## Failures, alarms, and recovery

| Category          | Examples                                                      | Policy                                                             |
| ----------------- | ------------------------------------------------------------- | ------------------------------------------------------------------ |
| Authentication    | Bad key, OAuth 400/401, repeated Sheets 401                   | Pending/blocked; retry after 24 hours; operator fixes credentials. |
| Authorization     | HTTP 403                                                      | Pending/blocked; 24-hour retry; review sharing/API permission.     |
| TargetUnavailable | HTTP 404                                                      | Pending/blocked; 24-hour retry; review target and sharing.         |
| Schema            | Missing tabs, wrong headers/marker, unexpected rows, HTTP 400 | Pending/blocked; 24-hour retry after operator repair.              |
| Configuration     | Missing runtime inputs, duplicate targets, clinic mismatch    | Pending/blocked; 24-hour retry.                                    |
| MalformedPayload  | Invalid snapshot, unsupported version, oversized batch        | Pending/blocked; 24-hour retry; review payload/capacity.           |
| RateLimited       | HTTP 429                                                      | Bounded exponential retry, respecting numeric Retry-After.         |
| Transient         | HTTP 408/5xx, network errors, timeout, invalid success JSON   | Bounded exponential retry.                                         |

Transient/rate-limit delay starts at 30 seconds, doubles with failed attempts, and
caps at one hour. Numeric Retry-After is honored up to that cap. HTTP requests have
a 10-second timeout including body consumption and do not follow redirects.
Response error bodies, private keys, and tokens are never logged or persisted.
Permanent/configuration failures are probed only once per day; they remain visible
and are not discarded. A 403 is deliberately treated conservatively as an access
problem; quota-specific 403 responses need operator review.

A timed-out batch may still be running at Google. Uncertain/transient batch-write
failures impose at least 210 seconds before the next attempt, beyond Google's
published 180-second request-processing limit. This avoids advancing the revision
while an older write may still complete. Do not bypass that delay when recovering.
After acknowledgement loss, retry reads the completed marker and safely becomes
a no-op. This relies on Google's processing limit and the single-writer model;
review this assumption when changing the API/client or delivery topology.

The outbox catches classified failures, stores a safe category/message, increments
attempt counts, calculates next_attempt_at, and explicitly schedules another alarm.
A new booking cannot bypass an older job's retry deadline. `drainProjection(clinicId)`
is an internal attempt-now operation that still honors the stored deadline. No
finite retry-count limit discards work. Alarms persist across eviction/restarts;
Cloudflare's finite automatic alarm retries are not the long-outage strategy.

Each drain handles at most 25 snapshots and starts no further snapshot after 20
seconds of elapsed time. Pending work gets another alarm. SQL failure while saving
retry metadata is a storage fault and propagates to Cloudflare's alarm retry; when
SQLite itself is unavailable the service cannot promise to persist new diagnostics.
Projection failure never changes authoritative booking success or slot availability.

## Backlog observability and migration

`projectionStatus(clinicId)` returns an internal RPC result with:

- pending and failed job counts, oldestPendingAt, and pendingBytes;
- failedAttemptCount (cumulative) and headAttemptCount;
- nextAttemptAt and lastDeliveredRevision;
- lastFailure with safe category/message, automaticRetry, and timestamp;
- blocked when the oldest pending job requires configuration/operator attention.

Times are epoch milliseconds; absent times/failure are null. A successful drain
retains the historical last failure and cumulative count for observability. No
monitoring dashboard or customer data is included in these metrics.

An additive SQLite delivery migration adds created_at to outbox rows and a
projection_delivery singleton (delivery version 1) for diagnostics. Existing Task 3
snapshots, attempt counts, and retry times are preserved. Legacy creation times are
recovered from snapshot activity timestamps (second precision), falling back to the
old next-attempt time if unavailable. A legacy last failure has unknown timestamp.
The domain-record schema remains version 1. Unsupported migration versions fail
closed; the entire migration is transactional and safe to re-run.

Full snapshots still grow with clinic history and backlog length. This task adds
observability and bounded draining, not retention or compaction. Connect alerts for
pending age/bytes and storage capacity before a real clinic; do not silently drop
snapshots at a high attempt count. Large snapshots currently require an operational
capacity review instead of unsafe partial delivery.

## Staff edits, local tests, and first connection review

System-managed settings, appointment, patient, and activity rows are output, never
input. Staff should not alter keys, revisions, headers, metadata, or projected data.
Use Sheets protected ranges for these tabs where practical; set this up with the
spreadsheet owner. Bootstrap does not alter sharing or add Drive permission logic.
Configuration changes remain in the Durable Object; there is no bidirectional sync.

Automated tests fake only Google HTTP and generate temporary signing keys in memory.
Test bindings override Google configuration with empty values so local development
secrets cannot enable delivery accidentally. Existing domain/SQLite tests remain
unchanged. No live integration test runs by default and no credentials are required.
Before the first real connection, review sharing, token scope/key rotation, protected
ranges, single-writer routing, slow-error recovery, target reassignment/restore,
quota consumption, response size, and backlog storage limits. A new target needs
bootstrap plus a new authoritative snapshot; historical jobs already acknowledged
on a previous target are not automatically replayed.

References: [service-account OAuth](https://developers.google.com/identity/protocols/oauth2/service-account),
[Sheets batch update](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/batchUpdate),
[updateCells behavior](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/request#UpdateCellsRequest),
and [Google API limits](https://developers.google.com/workspace/sheets/api/limits).
