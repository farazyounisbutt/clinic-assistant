# Queue boundary

`orderCheckedInQueue` is pure and scoped to one clinic/date. It selects CheckedIn
appointments and orders them by UTC checkedInAt, local appointment start, then ID.
Walk-ins share this model and lifecycle. Token issuance, priority overrides, estimated
wait times, UI, and messaging remain outside the current milestone.
