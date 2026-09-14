# Clinic Assistant

WhatsApp-first clinic appointment and queue management service.

InLoop operates the service. Patients will use WhatsApp, clerks will use WhatsApp
and Google Sheets, and doctors will receive WhatsApp summaries.

## Current milestone: core scheduling and booking

Strict TypeScript domain models, pure availability calculation, atomic booking and
rescheduling operations, cancellation/check-in/completion/NoShow transitions, and
checked-in queue ordering. Storage, messaging, clocks, and ID generation use ports.
There is no frontend, HTTP server, database, or live integration. An in-memory
coordinator exists only in tests to exercise concurrency and rollback guarantees.
All dependencies are development tools; the production core has no dependencies.

## Development

Use Node.js 22.13+ (22.x), 24.x, or 26+ and npm. Install reproducibly with `npm ci`.

| Command                 | Purpose                                        |
| ----------------------- | ---------------------------------------------- |
| `npm run typecheck`     | Check source and tests with strict TypeScript  |
| `npm run lint`          | Run ESLint with no warnings allowed            |
| `npm test`              | Run deterministic unit tests once              |
| `npm run test:watch`    | Watch tests during development                 |
| `npm run test:coverage` | Run tests with 80% minimum coverage thresholds |
| `npm run format`        | Apply Prettier                                 |
| `npm run format:check`  | Check formatting                               |
| `npm run check`         | Run type-check, lint, tests, formatting check  |
| `npm run build`         | Emit ESM JavaScript and declarations into dist |

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
types and ports. `queue` provides pure ordering; `reports` reserves future work. `adapters`
will implement storage and messaging boundaries. `config` is runtime-independent;
`index.ts` exports the foundation for future runtime composition.

Google Sheets is the intended first storage adapter and PostgreSQL the future
replacement. WhatsApp Cloud API and a Cloudflare Worker entrypoint are future work.
Neither service-specific APIs nor credentials appear in business logic. Every record
is clinic-scoped. Every future adapter must satisfy the atomic booking/rescheduling
contract. The test store is not a production persistence implementation.

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

Read [architecture](docs/architecture.md), [POC scope](docs/poc-scope.md),
[data model](docs/data-model.md), [availability algorithm](docs/availability.md),
and [appointment lifecycle](docs/appointment-lifecycle.md).
Contributor instructions are in [AGENTS.md](AGENTS.md).

Tooling references: [TypeScript NodeNext](https://www.typescriptlang.org/docs/handbook/esm-node.html),
[Vitest guide](https://vitest.dev/guide/), and
[typescript-eslint configs](https://typescript-eslint.io/users/configs/).

Real clinic identity, doctor name, specialty, working hours, WhatsApp number, and
customer-specific settings belong in runtime clinic configuration/data. Repository
examples use demo_clinic, Demo Doctor, Specialist, and synthetic contact details.
