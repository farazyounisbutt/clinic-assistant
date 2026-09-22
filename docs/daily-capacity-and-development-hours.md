# Daily capacity and development hours (Phase 1)

## Capacity policy

`Clinic.dailyAppointmentLimit` is optional. Omit it for unlimited capacity; when
present it must be a positive safe integer. `DAILY_APPOINTMENT_LIMIT` is the
optional equivalent for `loadConfig`; environment defaults do not overwrite an
existing Durable Object configuration. No clinic limit is enabled automatically.
A value of 20 can be supplied later through approved runtime clinic configuration.

Capacity uses the appointment's clinic-local calendar date, not its booking or
completion timestamp. Scheduled, CheckedIn, Completed and NoShow each consume one
place. Cancelled and Rescheduled consume none. This policy lives in
`src/scheduling/capacity.ts`, separate from time-slot occupancy. Completing a
patient early frees the slot but does **not** free daily capacity.

All sources, including patient bookings and clerk walk-ins, share the final
availability check inside the clinic's serialized write transaction. Staff cannot
override it. Full dates return no slots. Patient date choices exclude full dates;
a date that fills after selection returns a fully-booked message and offers other
dates. If the entire window has no availability, the patient returns to the menu.

Rescheduling excludes only the original appointment while checking the replacement.
A same-day move at the limit therefore consumes one place, not two. Cross-day
moves require capacity on the target date and release capacity on the old date.
Failed replacements preserve the original. Existing reschedule creation/linkage
and audit events are unchanged. Cancellation frees a place without deleting history.

The repository validates the final staged capacity as a second line of defense.
Lowering a configured limit below existing usage retains all records and still
allows check-in/completion/no-show/cancellation. New reservations are blocked until
usage is below the limit. The service also blocks rescheduling into an already
over-limit date (including same-day moves when usage exceeds, rather than equals,
the limit). No automatic lifecycle transitions or historical data rewrites occur.

## Storage and Sheets compatibility

SQLite continues to store allowlisted clinic settings as JSON. No SQL migration,
Durable Object recreation, or data backfill is needed. Existing records without the
field remain unlimited. Existing appointments, patients, blocks and audit events
are retained. The DO namespace and migration identifiers stay unchanged.

`Clinic_Settings` gains a trailing `Daily_Appointment_Limit` column; blank means
unlimited. The six-sheet projection remains schema version 1 with this explicitly
supported optional extension. The adapter accepts the exact old settings header
and queued old snapshots. On the next newer snapshot it appends the header (and a
grid column if required) atomically with the normal full snapshot and revision
marker. Old snapshots project blank for the missing limit. Replayed older revisions
cannot overwrite a newer limit. Unexpected headers or extra old-schema cells fail
closed; nothing is silently discarded. Other sheet schemas and record keys do not
change. Validation itself performs no schema writes.

Do not roll back to an older Worker after this column extension without a separate
review: the old strict-header adapter will reject the extended sheet. Authoritative
records remain safe; projection would pause. Do not clear sheets or bootstrap a new
target as a migration workaround.

## Development-only schedule default

The explicit helper `developmentEveningHours` changes the known development
schedule to 09:00–21:00 every day, Asia/Karachi. It accepts only
`integration_test_clinic`, preserves clinic settings (including any daily limit),
blocked slots and breaks, and refuses unfamiliar layouts for review. It never runs
at Worker startup or for ordinary clinic provisioning. Future production clinics
still require their own persisted hours. Source changes alone do not update the
currently deployed clinic.

## Reviewed deployment and persisted update procedure

**Approval required before executing deployment or the POST below.** These commands
are a procedure, not work already performed. Do not change Meta configuration.
Run from the repository root with the existing authenticated development account.
Ensure `.dev.vars` contains `DEVELOPMENT_ADMIN_TOKEN` matching the development
Worker; never echo it. `.wrangler` comparison files are ignored and private.

1. Review Phase 1, run `npm run check`, `npm run test:coverage`, and `npm run build`.
   Build is a dry run and produces `dist/config/development.js`. Confirm the
   intended Cloudflare account with `node_modules/.bin/wrangler whoami`.
2. After approval, deploy **only** the development environment:

   ```sh
   node_modules/.bin/wrangler deploy --env development --dry-run
   node_modules/.bin/wrangler deploy --env development
   ```

   This uses `wrangler.jsonc`, `env.development`, and
   `src/adapters/cloudflare/development.ts`. Do not omit `--env development`.
   Keep the existing `CLINICS` namespace and migration `v1`; do not delete/recreate
   the object. This deployment does not itself alter persisted hours or enable a limit.

3. Prepare the hours update from the current protected inspection endpoint. Stop
   test interactions while preparing/reviewing/applying the update so verification
   is unambiguous. A revision precondition still protects against concurrent writes.
   If projection is pending/failed, investigate and finish it before preparing.

   ```sh
   node --input-type=module <<'JS'
   import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
   import { parseEnv } from 'node:util';
   import { developmentEveningHours } from './dist/config/development.js';
   const env = parseEnv(readFileSync('.dev.vars', 'utf8'));
   if (!env.DEVELOPMENT_ADMIN_TOKEN) throw Error('Development admin token missing');
   const base = 'https://clinic-assistant-development.faraz-younis.workers.dev';
   const response = await fetch(base + '/__development/inspect', {
     headers: { authorization: `Bearer ${env.DEVELOPMENT_ADMIN_TOKEN}` }
   });
   if (!response.ok) throw Error('Inspection failed');
   const before = await response.json();
   if (!Number.isSafeInteger(before.configurationRevision) ||
       before.projection.pending || before.projection.failed || before.inbox.pending)
     throw Error('Inspect deployment or pending work before continuing');
   const config = developmentEveningHours({ clinic: before.clinic,
     workingHours: before.workingHours, blockedSlots: before.blockedSlots });
   mkdirSync('.wrangler/phase1-review', { recursive: true, mode: 0o700 });
   writeFileSync('.wrangler/phase1-review/before.json', JSON.stringify(before), { mode: 0o600 });
   writeFileSync('.wrangler/phase1-review/plan.json', JSON.stringify({
     expectedRevision: before.configurationRevision, config
   }, null, 2), { mode: 0o600 });
   console.log('Prepared private plan: seven 09:00–21:00 periods; clinic settings and blocks retained.');
   JS
   ```

   Privately review `plan.json`: only period end times should change from 18:00 to
   21:00. Do not share its contents in logs. `before.json` is a **masked comparison
   snapshot**, not a full contact-data backup. It is never imported back into the DO.
   Do not add the intended production limit to this hours-only plan.

4. Once the plan is approved, apply it with its revision precondition:

   ```sh
   node --input-type=module <<'JS'
   import { readFileSync } from 'node:fs';
   import { parseEnv } from 'node:util';
   const env = parseEnv(readFileSync('.dev.vars', 'utf8'));
   if (!env.DEVELOPMENT_ADMIN_TOKEN) throw Error('Development admin token missing');
   const plan = JSON.parse(readFileSync('.wrangler/phase1-review/plan.json', 'utf8'));
   const base = 'https://clinic-assistant-development.faraz-younis.workers.dev';
   const headers = { authorization: `Bearer ${env.DEVELOPMENT_ADMIN_TOKEN}` };
   const response = await fetch(base + '/__development/configure', {
     method: 'POST', headers: { ...headers, 'content-type': 'application/json',
       'if-match': String(plan.expectedRevision) }, body: JSON.stringify(plan.config)
   });
   if (response.status === 409) throw Error('State changed: re-read and review a new plan; do not retry blindly');
   if (!response.ok || !(await response.json()).ok) throw Error('Configuration update failed');
   console.log('Hours update accepted; verify state and projection next.');
   JS
   ```

   The existing configure transaction retains appointments/patients/activity,
   preserves the submitted blocks, and adds one `ConfigurationUpdated` event and
   one revision. The precondition is checked under the same mutex as bookings,
   reschedules, blocks and configuration. On conflict, nothing is changed.

5. Read `/__development/inspect` again with the same authorization. Compare privately:
   - `configurationRevision == expectedRevision + 1`;
   - clinic settings unchanged (including limit), seven active 09:00–21:00 periods;
   - appointments, patients and blocked slots equal to `before.json`;
   - all previous activity retained, exactly one additional `ConfigurationUpdated`;
   - projection pending/failed both zero and last delivered revision equals the new revision.
     Use the existing projection drain endpoint if needed, then inspect again; never
     acknowledge or delete pending work manually. Compare **all six** managed Google
     Sheets against the same revision, especially Working_Hours and Clinic_Settings.
     On a future open date, use the patient booking date/time list to verify an evening
     slot (for 20-minute appointments, 20:40–21:00 is the last possible slot) and no
     21:00 start. Blocks, occupied slots and daily capacity must still exclude slots.
     Stop before confirming a new appointment unless a live test booking is approved.

A rollback of hours requires a fresh inspected configuration and current revision,
changing only end times after approval; do not POST an old full snapshot that could
remove new blocks or settings. Existing evening appointments must remain in history.

## Questions for clinic feedback

- Confirm whether Completed and NoShow should permanently consume that date's quota.
- Confirm the quota is per appointment record, rather than per unique patient or doctor.
- Confirm how same-day moves should behave after a limit is lowered below existing usage.
- Confirm whether a later phase needs date-specific quotas, staff overrides or waiting lists.
- Decide the actual runtime limit per clinic. No production limit is set by this change.

Phase 2 Doctor's View is intentionally deferred until Phase 1 review.
