# Google Sheets projection adapter

`GoogleSheetsProjection` implements `ClinicRecordProjection` using the Google Sheets
REST API. `GoogleServiceAccountTokens` signs fixed RS256 assertions with Web Crypto,
caches OAuth tokens, and supplies the HTTP client. No Node SDK is required.

The clinic Durable Object owns the target, serializes delivery, and persists retry
state. Sheets is operational/export output, never booking authority. Bootstrap is
explicit and refuses nonempty or incompatible targets. No account is connected here.

See `docs/google-sheets.md` for setup, internal RPC, failure handling, and limits;
`docs/sheets-schema.md` defines unchanged v1 columns. No credentials or customer
spreadsheet IDs belong in this repository.
