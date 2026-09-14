import type { Appointment } from '../appointments/models.js';
import type { Clinic } from '../clinic/models.js';
import type { Patient } from '../patients/models.js';
import type { BlockedSlot, WorkingHours } from '../scheduling/models.js';

export interface ClinicConfiguration {
  readonly clinic: Clinic;
  readonly workingHours: readonly WorkingHours[];
  readonly blockedSlots: readonly BlockedSlot[];
}
export interface ActivityEvent {
  readonly eventId: string;
  readonly clinicId: string;
  readonly timestamp: string;
  readonly actorId: string;
  readonly action: string;
  readonly appointmentId: string | null;
  readonly detail: string;
}
export interface ClinicRecords {
  readonly clinic: Clinic | null;
  readonly workingHours: readonly WorkingHours[];
  readonly blockedSlots: readonly BlockedSlot[];
  readonly patients: readonly Patient[];
  readonly appointments: readonly Appointment[];
  readonly activity: readonly ActivityEvent[];
}
export type SheetName =
  | 'Clinic_Settings'
  | 'Working_Hours'
  | 'Blocked_Slots'
  | 'Appointments'
  | 'Patients'
  | 'Activity_Log';
export interface ProjectionRow {
  readonly key: string;
  readonly cells: readonly (string | number | boolean | null)[];
}
export interface ClinicProjectionSnapshot {
  readonly schemaVersion: 1;
  readonly clinicId: string;
  readonly revision: number;
  readonly sheets: Readonly<Record<SheetName, readonly ProjectionRow[]>>;
}
/**
 * Replace the clinic's managed rows with this immutable snapshot. Upsert by
 * (clinicId, sheet, row.key), remove obsolete managed keys, and ignore revisions
 * older than the last fully applied revision. Resolve only after ALL sheets are
 * applied. Retries after partial writes must converge; never append blindly.
 * A future Sheets adapter must write text as RAW (including formula-like input).
 */
export interface ClinicRecordProjection {
  applySnapshot(snapshot: ClinicProjectionSnapshot): Promise<void>;
}
