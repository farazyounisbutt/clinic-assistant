# Future Google Sheets adapter

No integration is implemented. Map rows to domain records behind storage ports;
do not expose row numbers, spreadsheets, or credentials to business logic.
Sheets alone does not satisfy the serialized, all-or-nothing appointment write
contract. A coordinated write/recovery strategy must be designed before bookings
are enabled. Direct clerk edits must not bypass booking coordination.
