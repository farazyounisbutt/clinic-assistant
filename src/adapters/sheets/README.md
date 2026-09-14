# Future Google Sheets adapter

No integration is implemented. Every future persistence adapter must honor the
atomic booking/rescheduling contract in `docs/architecture.md`. Business logic must
remain independent of spreadsheet APIs, row coordinates, and credentials.
