# Future Google Sheets projection adapter

Google Sheets is an operational/export projection, never the booking authority.
Implement `ClinicRecordProjection` from `src/ports/projection.ts` using the exact
headers and stable keys in `src/projection/sheets.ts`. Upsert the same logical rows
on retry, remove obsolete managed rows, and ignore stale snapshot revisions.

The clinic Durable Object's SQLite transaction enforces booking correctness and
queues projection work. A Sheets failure leaves the authoritative booking reserved.
No Google API, account, credentials, or live spreadsheet is connected here.

See `docs/sheets-schema.md` for columns and managed-row protection and
`docs/persistence.md` for delivery, backoff, and recovery semantics.
