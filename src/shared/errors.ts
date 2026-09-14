export type DomainErrorCode =
  | 'ClinicNotFound'
  | 'InvalidClinicConfiguration'
  | 'SubscriptionInactive'
  | 'DateOutsideBookingHorizon'
  | 'SameDayBookingDisabled'
  | 'ClinicClosed'
  | 'SlotInPast'
  | 'SlotOutsideWorkingHours'
  | 'SlotOffGrid'
  | 'SlotOverlapsBreak'
  | 'SlotBlocked'
  | 'SlotConflict'
  | 'InvalidAppointmentTransition'
  | 'AppointmentNotFound'
  | 'InvalidReschedule'
  | 'InvalidInput'
  | 'InvalidSchedule'
  | 'InvalidLocalTime';

/** Callers branch on code, never on human-readable messages. */
export class DomainError extends Error {
  override readonly name = 'DomainError';
  constructor(
    readonly code: DomainErrorCode,
    message: string = code,
  ) {
    super(message);
  }
}
