# Appointment lifecycle

```text
Scheduled -> CheckedIn -> Completed
    |------> NoShow
    |------> Cancelled
    `------> Rescheduled
```

Only these five directed transitions are valid. Self-transitions, skipping check-in,
and returning from terminal states are rejected. The pure lifecycle helpers check
status edges; they do not authenticate actors, update timestamps, save records,
or execute bookings. There is deliberately no generic status-update service yet.

| Transition              | Future use-case obligations                                    |
| ----------------------- | -------------------------------------------------------------- |
| Scheduled → CheckedIn   | Explicit check-in; set checkedInAt                             |
| CheckedIn → Completed   | Explicit completion; set completedAt                           |
| Scheduled → NoShow      | Explicit clerk action; never a timer or elapsed-time inference |
| Scheduled → Cancelled   | Set cancelledAt and retain the record                          |
| Scheduled → Rescheduled | Retain original and atomically create/link a replacement       |

Scheduled and CheckedIn reserve appointment time. Completed, NoShow, Cancelled,
and Rescheduled do not reserve it. Whether a time is otherwise bookable still
depends on working hours, breaks, blocked slots, horizon, and same-day policy.
Walk-ins follow exactly the same lifecycle.

## Reschedule record preservation

For appointment A moved to a new slot, a future use case must:

1. Load A in its clinic under the appointment write coordinator and require Scheduled.
2. Recheck the replacement slot against fresh availability immediately before writing.
3. Create B with a new ID, status Scheduled, new slot and bookedAt, rescheduledFrom=A,
   rescheduledTo=null, and null check-in/completion/cancellation timestamps.
4. Preserve A's original slot, patient snapshots, booking metadata, and ID. Set only
   its status to Rescheduled and rescheduledTo=B as part of this operation.
5. Commit both changes together before sending confirmation. A failed write must
   leave A unchanged and B absent.

Later moves form a chain (A → B → C). Do not delete A, overwrite its slot, or record
a reschedule as cancellation. Adapter contract tests for atomic writes, retries,
cross-clinic rejection, and concurrent bookings are required when storage is added.
This task tests the complete status-transition matrix; no persistence exists yet.
