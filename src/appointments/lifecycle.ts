import { AppointmentStatus } from './models.js';

const transitions: Readonly<
  Record<AppointmentStatus, readonly AppointmentStatus[]>
> = {
  Scheduled: [
    AppointmentStatus.CheckedIn,
    AppointmentStatus.NoShow,
    AppointmentStatus.Cancelled,
    AppointmentStatus.Rescheduled,
  ],
  CheckedIn: [AppointmentStatus.Completed],
  Completed: [],
  NoShow: [],
  Cancelled: [],
  Rescheduled: [],
};

/** Transition policy only; this does not mutate or persist an appointment. */
export function canTransitionAppointmentStatus(
  from: AppointmentStatus,
  to: AppointmentStatus,
): boolean {
  return transitions[from].includes(to);
}

export function assertAppointmentStatusTransition(
  from: AppointmentStatus,
  to: AppointmentStatus,
): void {
  if (!canTransitionAppointmentStatus(from, to)) {
    throw new Error(`Invalid appointment status transition: ${from} -> ${to}`);
  }
}

/** These statuses reserve scheduled time for availability calculations. */
export function isActiveAppointmentStatus(status: AppointmentStatus): boolean {
  return (
    status === AppointmentStatus.Scheduled ||
    status === AppointmentStatus.CheckedIn
  );
}
