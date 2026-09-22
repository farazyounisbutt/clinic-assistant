export const SubscriptionStatus = {
  Active: 'active',
  Inactive: 'inactive',
  Suspended: 'suspended',
} as const;
export type SubscriptionStatus =
  (typeof SubscriptionStatus)[keyof typeof SubscriptionStatus];

export interface Clinic {
  readonly clinicId: string;
  readonly doctorName: string;
  readonly specialty: string;
  readonly timezone: string;
  readonly appointmentDurationMinutes: number;
  readonly bookingHorizonDays: number;
  /** Omitted means unlimited. Counted independently of time-slot occupancy. */
  readonly dailyAppointmentLimit?: number;
  readonly sameDayBookingAllowed: boolean;
  readonly subscriptionStatus: SubscriptionStatus;
}
