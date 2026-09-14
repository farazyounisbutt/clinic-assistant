# Architecture

One small modular service, owned and operated by InLoop. There are no microservices
or live external integrations in the foundation.

```text
Future WhatsApp/HTTP input -> runtime composition -> application use cases
                                                   | domain rules
                                                   | storage/messaging ports
                                                   v
                                         future external adapters
```

## Boundaries

| Module         | Responsibility                                                 |
| -------------- | -------------------------------------------------------------- |
| `clinic`       | Clinic settings and subscription state                         |
| `scheduling`   | Working hours, breaks, blocked-slot types; future availability |
| `appointments` | Appointment records and pure lifecycle policy                  |
| `patients`     | Administrative patient contacts                                |
| `queue`        | Reserved boundary for future queue rules                       |
| `reports`      | Reserved boundary for future summaries                         |
| `ports`        | Clinic-scoped storage and channel-neutral messaging contracts  |
| `adapters`     | Reserved Sheets and WhatsApp integration boundaries            |
| `config`       | Validated settings from an injected environment map            |
| `shared`       | Date, time, timestamp, and time-range types                    |
| `index.ts`     | Public exports and future composition boundary                 |

Core logic imports no integration SDKs or Node APIs. ESM and NodeNext compilation
produce Node-compatible JavaScript; keeping the core runtime-neutral prepares it
for a future Worker entrypoint and bundler. No Worker deployment is configured.

TypeScript interfaces describe trusted internal values; they do not validate
untrusted JSON, webhook payloads, or spreadsheet rows. Future boundary adapters
must validate identifiers, date/time formats, phone numbers, and record invariants.
The current runtime validators cover environment configuration and status edges.

## Storage replacement and concurrency

Google Sheets is the intended initial POC storage; PostgreSQL is the later option.
Adapters map native data to domain records and never expose sheet coordinates or
SQL objects to use cases. Reads include `clinicId`; writes reject cross-clinic data.

Appointment mutation is exposed only through `AppointmentWriteCoordinator`, which
serializes operations per clinic across all service instances. A future booking use
case reads fresh working hours, breaks, blocked slots, and active appointments inside
that operation, checks availability, writes, and only then confirms the booking.
All state changes affecting availability must participate in the same coordination.

The contract requires all-or-nothing writes, including both records in a reschedule.
Sheets alone cannot provide this contract. Its adapter will need middleware
coordination plus a recovery strategy, and clerk edits must not bypass it. PostgreSQL
can implement the port using transactions and suitable concurrency constraints.
This foundation defines the requirement; it does not claim to implement atomicity.

Send messages after successful storage commit. Delivery retries and request
idempotency must be designed with the integration; they are not implemented here.
Clinic scoping is a storage contract, not a substitute for future actor authorization.

## Configuration

`loadConfig(environment)` accepts a string-valued map. Node callers pass
`process.env`; Worker callers later pass their environment bindings. The loader
does not read files or global process state. `.env.example` documents non-secret
demo values. Working hours are separate records, with no fabricated defaults.

The configuration currently represents one demo clinic. Future multi-clinic
composition loads clinic settings through `ClinicRepository` without changing the
domain. No payment or subscription enforcement logic is included.
