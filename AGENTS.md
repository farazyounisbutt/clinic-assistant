# Repository guidance

This product is a WhatsApp-first clinic appointment and queue management service.
Keep scope
limited to the current task; do not introduce a frontend, microservices, a database,
external credentials, or live integrations without an explicit request.

## Architecture

- Business logic belongs in domain modules and must remain independent of Google
  Sheets, WhatsApp, Cloudflare, and PostgreSQL.
- Depend on interfaces in `src/ports`; adapters implement those interfaces.
- Runtime composition belongs at the entry boundary. Inject environment values,
  storage, messaging, clocks, and ID generators when those capabilities are needed.
- Every record and repository operation must preserve clinic isolation.
- Never weaken the availability recheck or serialized write contract. Rescheduling
  preserves the original record and links a new appointment.
- Read `docs/` before changing appointment or scheduling policy.

## Conventions and verification

- Use strict TypeScript, ESM with `.js` local import specifiers, explicit exported
  types, type-only imports, and readonly domain records.
- Keep dependencies minimal. Runtime-specific APIs belong at adapter boundaries.
- Use npm and commit the lockfile. Apply Prettier; follow ESLint.
- Add focused Vitest tests for business rules, invalid inputs, and regressions.
  Tests must be deterministic and require no network or live credentials.
- Before completion run `npm run check` and `npm run build`, inspect the diff,
  and scan changed files for credentials or sensitive patient information.

## Data and secrets

- Never commit secrets, tokens, private keys, `.env` files, or real patient data.
- Keep examples clinic-agnostic: demo_clinic, Demo Doctor, and Specialist. Real
  clinic identity, specialty, schedule, phone numbers, and customer settings belong
  in runtime clinic configuration/data, never repository defaults or history.
- `.env.example` contains only public examples and placeholders.
- Do not store medical history, diagnosis, prescriptions, CNIC, or clinical records.
- Appointment reasons are administrative notes only. Avoid patient information in
  logs and test fixtures; use clearly synthetic examples.
