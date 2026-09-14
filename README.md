# Clinic Assistant

WhatsApp-first clinic appointment and queue management service.

InLoop operates the service. Patients will use WhatsApp, clerks will use WhatsApp
and Google Sheets, and doctors will receive WhatsApp summaries.

## Current foundation

Strict TypeScript domain models, appointment lifecycle rules, storage/messaging
interfaces, validated environment configuration, and Vitest tests. There is no
frontend, HTTP server, database, live integration, or booking implementation yet.
All dependencies are development tools; the production core has no dependencies.

## Development

Use Node.js 22.13+ (22.x), 24.x, or 26+ and npm. Install reproducibly with `npm ci`.

| Command                | Purpose                                        |
| ---------------------- | ---------------------------------------------- |
| `npm run typecheck`    | Check source and tests with strict TypeScript  |
| `npm run lint`         | Run ESLint with no warnings allowed            |
| `npm test`             | Run deterministic unit tests once              |
| `npm run test:watch`   | Watch tests during development                 |
| `npm run format`       | Apply Prettier                                 |
| `npm run format:check` | Check formatting                               |
| `npm run check`        | Run type-check, lint, tests, formatting check  |
| `npm run build`        | Emit ESM JavaScript and declarations into dist |

Configuration defaults match the demo: `demo_clinic`, `Asia/Karachi`, 20 minutes,
30 days, same-day allowed, subscription active. `.env.example` contains only public
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
types and ports. `queue` and `reports` reserve future responsibilities. `adapters`
will implement storage and messaging boundaries. `config` is runtime-independent;
`index.ts` exports the foundation for future runtime composition.

Google Sheets is the intended first storage adapter and PostgreSQL the future
replacement. WhatsApp Cloud API and a Cloudflare Worker entrypoint are future work.
Neither service-specific APIs nor credentials appear in business logic. Every record
is clinic-scoped. Booking confirmation must recheck availability inside coordinated
writes; Sheets concurrency and recovery must be resolved before enabling bookings.

Read [architecture](docs/architecture.md), [POC scope](docs/poc-scope.md),
[data model](docs/data-model.md), and [appointment lifecycle](docs/appointment-lifecycle.md).
Contributor instructions are in [AGENTS.md](AGENTS.md).

Tooling references: [TypeScript NodeNext](https://www.typescriptlang.org/docs/handbook/esm-node.html),
[Vitest guide](https://vitest.dev/guide/), and
[typescript-eslint configs](https://typescript-eslint.io/users/configs/).

Real clinic identity, doctor name, specialty, working hours, WhatsApp number, and
customer-specific settings belong in runtime clinic configuration/data. Repository
examples use demo_clinic, Demo Doctor, Specialist, and synthetic contact details.
