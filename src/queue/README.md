# Queue boundary

Future queue logic consumes clinic-scoped appointments through ports. Walk-ins use
the same appointment model and lifecycle. Queue ordering, priority, token issuance,
and estimated wait times are deliberately not implemented in this foundation.
