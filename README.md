# Clinic Assistant

WhatsApp-first clinic appointment and queue management service.

InLoop operates the service. Patients will use WhatsApp, clerks will use WhatsApp
and Google Sheets, and doctors will receive WhatsApp summaries.

## Current milestone: WhatsApp patient conversations

Strict TypeScript domain models, pure availability calculation, atomic booking and
rescheduling operations, cancellation/check-in/completion/NoShow transitions, and
checked-in queue ordering. Storage, messaging, clocks, and ID generation use ports.
A Cloudflare Worker composes one SQLite-backed Durable Object per clinic. Bookings,
audit events, and a durable projection outbox commit atomically. The Google Sheets REST adapter uses service-account authentication and stable-ID
upserts behind a durable retry queue. The authenticated WhatsApp webhook adds patient
booking, lookup, cancellation, and rescheduling with durable conversation state and
idempotency. No Meta account setup or deployment is performed.
The in-memory coordinator remains a test reference.
All dependencies are development tools; the production core has no dependencies.

## Development

Use Node.js 22.13+ (22.x), 24.x, or 26+ and npm. Install reproducibly with `npm ci`.

| Command                 | Purpose                                                     |
| ----------------------- | ----------------------------------------------------------- |
| `npm run typecheck`     | Check source and tests with strict TypeScript               |
| `npm run lint`          | Run ESLint with no warnings allowed                         |
| `npm test`              | Run domain and local Cloudflare tests                       |
| `npm run test:watch`    | Watch tests during development                              |
| `npm run test:coverage` | Run tests with 80% minimum coverage thresholds              |
| `npm run format`        | Apply Prettier                                              |
| `npm run format:check`  | Check formatting                                            |
| `npm run check`         | Run type-check, lint, tests, formatting check               |
| `npm run build`         | Emit core ESM and dry-run bundle the Worker (no deployment) |

Neutral demo configuration defaults: `demo_clinic`, `Asia/Karachi`, 20 minutes,
30 local dates (today through day 29), same-day allowed, subscription active. `.env.example` contains only public
example values. Copy it to `.env` if local overrides are needed; tests do not need it.
The loader receives environment values explicitly and does not load `.env` itself.
After building, this Node example loads a local `.env` without an extra dependency:

```sh
node --env-file=.env --input-type=module -e 'import { loadConfig } from "./dist/index.js"; const config = loadConfig(process.env); console.log(config.clinic.clinicId);'
```

Working hours remain unset until supplied by the clinic. Never commit credentials
or real patient data. This system stores administrative records, not clinical records.

## Architecture and future work

Domain modules (`clinic`, `scheduling`, `appointments`, `patients`) depend on plain
types and ports. `queue` provides pure ordering; `reports` reserves future work. `adapters/cloudflare`
implements persistence and runtime composition. `config` is runtime-independent;
`index.ts` exports the foundation for future runtime composition.

SQLite in each clinic Durable Object is the booking authority. Google Sheets is a
separate operational projection/export; failed delivery leaves bookings reserved and
queues retry work. WhatsApp-specific code stays in its adapter. Service APIs and
credentials never appear in the core. Internal RPC routes by clinic ID and rejects
mismatched object names. The public `/webhooks/whatsapp` route validates Meta signatures
and routes receiving phone IDs to clinics before durable enqueue. Other paths return 404.

`AppointmentService` exposes `availability`, `book`, `reschedule`, `transition`,
and `listAppointments` for existing-record reads/export consumers.
Inject an `AppointmentWriteCoordinator`, `Clock`, and `AppointmentIdGenerator`.
All appointment sources, including WalkIn, use `book`. Availability is never a
reservation: `book` rechecks fresh data under the coordinator and returns a committed
appointment or typed error. Callers handle `DomainError.code`, such as SlotConflict.

All new reservations, including walk-ins and reschedules, must start on a generated
slot grid and fit entirely inside a configured period and avoid any partial overlap
with breaks, blocked intervals, or Scheduled/CheckedIn records. Half-open intervals
allow adjacent appointments. Same-day starts must be strictly future in the clinic
timezone. Reschedules preserve linked history and roll back completely on failure.
NoShow requires an explicit Clerk action. Early completion is allowed when event
timestamps remain ordered. Inactive/suspended subscriptions block new reservations
and rescheduling while allowing existing-record management, reads, and exports.
Read operations never change status.

Read [WhatsApp architecture and local testing](docs/whatsapp.md),
[Google setup, bootstrap, and delivery](docs/google-sheets.md),
[persistence/recovery](docs/persistence.md), [exact Sheets schema](docs/sheets-schema.md),
[architecture](docs/architecture.md), [POC scope](docs/poc-scope.md),
[data model](docs/data-model.md), [availability algorithm](docs/availability.md),
and [appointment lifecycle](docs/appointment-lifecycle.md).
Contributor instructions are in [AGENTS.md](AGENTS.md).

Tooling references: [TypeScript NodeNext](https://www.typescriptlang.org/docs/handbook/esm-node.html),
[Vitest guide](https://vitest.dev/guide/), and
[typescript-eslint configs](https://typescript-eslint.io/users/configs/).

Real clinic identity, doctor name, specialty, working hours, WhatsApp number, and
customer-specific settings belong in runtime clinic configuration/data. Repository
examples use demo_clinic, Demo Doctor, Specialist, and synthetic contact details.

Cloudflare tests run locally with workerd and need loopback access. Vitest 4.1.11
is pinned to match the official Cloudflare plugin peer range; coverage uses Istanbul
because V8 coverage is unsupported in that runtime. Wrangler, Workers types, and
the test plugin are development dependencies; no Google SDK is installed.

Task 4 adds the real Worker-compatible Google adapter without new dependencies.
See `.env.example` for empty configuration placeholders. Never put service-account
credentials or clinic spreadsheet IDs in committed files.

Task 5 adds the direct HTTP Meta client without new dependencies. Patient flows use
the existing domain policies. [Clerk WhatsApp operations](docs/clerk-whatsapp.md) now add clinic-scoped staff authorization, walk-ins, lifecycle actions, and blocked time. Doctor messaging remains future work.
