import type { LocalDate, TimeRange, Timestamp } from '../shared/types.js';

export const AppointmentSource = {
  WhatsApp: 'WhatsApp',
  WalkIn: 'WalkIn',
  Clerk: 'Clerk',
  Phone: 'Phone',
} as const;
export type AppointmentSource =
  (typeof AppointmentSource)[keyof typeof AppointmentSource];

export const AppointmentStatus = {
  Scheduled: 'Scheduled',
  CheckedIn: 'CheckedIn',
  Completed: 'Completed',
  NoShow: 'NoShow',
  Cancelled: 'Cancelled',
  Rescheduled: 'Rescheduled',
} as const;
export type AppointmentStatus =
  (typeof AppointmentStatus)[keyof typeof AppointmentStatus];

export interface Appointment extends TimeRange {
  readonly appointmentId: string;
  readonly clinicId: string;
  readonly patientId: string;
  readonly patientName: string;
  readonly whatsappNumber: string;
  readonly appointmentDate: LocalDate;
  /** Administrative booking note only; no symptoms or clinical information. */
  readonly reason?: string;
  readonly source: AppointmentSource;
  readonly status: AppointmentStatus;
  readonly bookedAt: Timestamp;
  readonly checkedInAt: Timestamp | null;
  readonly completedAt: Timestamp | null;
  readonly cancelledAt: Timestamp | null;
  readonly rescheduledFrom: string | null;
  readonly rescheduledTo: string | null;
  /** Internal actor identifier, not a display name or credential. */
  readonly createdBy: string;
}
