# Appointment lifecycle

```text
Scheduled -> CheckedIn -> Completed
    |------> NoShow
    |------> Cancelled
    `------> Rescheduled
```

Only these five edges are valid. Self-transitions, skipping check-in, returning from
terminal states, and unknown statuses fail with InvalidAppointmentTransition.
`AppointmentService.transition` performs ordinary status changes atomically;
Rescheduled must use `reschedule` so history cannot be bypassed.

| Transition              | Behavior                                                                |
| ----------------------- | ----------------------------------------------------------------------- |
| Scheduled → CheckedIn   | Explicit check-in; sets checkedInAt                                     |
| CheckedIn → Completed   | Explicit completion; sets completedAt at or after check-in              |
| Scheduled → NoShow      | Requires explicit Clerk actor context; never inferred from elapsed time |
| Scheduled → Cancelled   | Sets cancelledAt and retains the appointment                            |
| Scheduled → Rescheduled | Atomically creates a linked replacement and preserves original record   |

The injected clock supplies UTC timestamps, which cannot precede the previous
booking/check-in event. Where check-in exists, checkedInAt must be at or after
bookedAt and completedAt must be at or after checkedInAt. Equality is allowed.
Completion can precede the scheduled start when a patient is seen early. Unrelated
metadata is retained, and the former future grid slot can become available again.

Cancellation frees the former future slot for another booking but never deletes the
record. NoShow and Rescheduled records are likewise nonblocking. Historical starts
remain unbookable regardless of status. No status changes occur during availability
queries or because the clock advances.

Actor identity/role is supplied by a trusted internal caller; future boundaries must
authenticate that context. The WhatsApp boundary now resolves clinic-scoped Clerk identities through the operator directory; internal RPC callers remain trusted.

## Rescheduling

For original appointment A moved to a new slot:

1. Load A under its clinic's write coordinator. Require Scheduled, no existing
   rescheduledTo link, and a different date/start. Otherwise raise InvalidReschedule.
2. Read fresh availability for the replacement, ignoring only A's own interval.
   A may be moved to a slot partially overlapping itself, but never another active record.
3. Validate that the replacement belongs to a generated available slot grid, create B with a fresh ID and Scheduled status, and insert
   B into the staged transaction. Set rescheduledFrom=A and rescheduledTo=null.
4. Only after insertion succeeds, stage A as Rescheduled with rescheduledTo=B.
   Retain A's original ID, slot, patient/contact snapshots, bookedAt, createdBy,
   reason, source, and prior metadata.
5. Commit both records together. Any validation, insertion, replacement, or commit
   failure leaves A unchanged and B absent. Resolve only after successful commit.

B retains A's patient/contact snapshot, source, and administrative reason, with its
new slot, bookedAt, and the rescheduling actor as createdBy. Its event timestamps
are null. Repeated reschedules form an A → B → C history chain. IDs must be unique;
collisions fail without overwriting any record.

## Walk-ins and queue

Walk-ins call the same `book` operation with source WalkIn. All normal slot, horizon,
subscription, and concurrency rules apply, including generated-grid and strictly
future starts. There is no arbitrary-time bypass. The
clerk can then explicitly transition the new record to CheckedIn. Check-in is a
separate operation; a successful booking is retained if that later operation fails.

`orderCheckedInQueue` selects CheckedIn records for one clinic/date and returns a
new array ordered by checkedInAt ascending, start time ascending, then appointment ID
for otherwise equal ties. Invalid/missing UTC arrival timestamps are rejected.
Queue ordering does not mutate input or change appointment status.
