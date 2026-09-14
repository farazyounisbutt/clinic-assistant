import type { Appointment } from '../appointments/models.js';
import type { Clinic } from '../clinic/models.js';
import type { Patient } from '../patients/models.js';
import type { BlockedSlot, WorkingHours } from '../scheduling/models.js';
import type { LocalDate } from '../shared/types.js';

export interface ClinicRepository {
  findById(clinicId: string): Promise<Clinic | null>;
  save(clinic: Clinic): Promise<void>;
}

export interface PatientRepository {
  findById(clinicId: string, patientId: string): Promise<Patient | null>;
  save(patient: Patient): Promise<void>;
}

export interface ScheduleRepository {
  listWorkingHours(clinicId: string): Promise<readonly WorkingHours[]>;
  listBlockedSlots(
    clinicId: string,
    date: LocalDate,
  ): Promise<readonly BlockedSlot[]>;
}

/** All reads must be scoped by clinic, including globally unique IDs. */
export interface AppointmentRepository {
  findById(
    clinicId: string,
    appointmentId: string,
  ): Promise<Appointment | null>;
  listByDate(
    clinicId: string,
    date: LocalDate,
  ): Promise<readonly Appointment[]>;
}

/**
 * A unit of work available only inside a serialized clinic booking operation.
 * Reads see staged writes. Insert rejects duplicate IDs; replace rejects missing IDs
 * or cross-clinic changes. Writes are invisible outside this unit until commit.
 * The unit must not be retained or used after the callback ends.
 */
export interface ClinicAppointmentUnitOfWork {
  readonly clinic: Clinic | null;
  listWorkingHours(): Promise<readonly WorkingHours[]>;
  listBlockedSlots(date: LocalDate): Promise<readonly BlockedSlot[]>;
  listAppointments(date: LocalDate): Promise<readonly Appointment[]>;
  findAppointment(appointmentId: string): Promise<Appointment | null>;
  insert(appointment: Appointment): Promise<void>;
  replace(appointment: Appointment): Promise<void>;
}

/**
 * Atomic booking boundary: serializes every appointment write per clinic across
 * all service instances and exposes fresh configuration/schedule/appointment data.
 * The callback rechecks availability before insertion. All writes commit together
 * or none do, including on commit failure. Rescheduling inserts its replacement
 * and updates the original in the same callback.
 *
 * BEFORE publishing a commit, the adapter MUST reject overlapping Scheduled or
 * CheckedIn records on the same clinic/date with DomainError('SlotConflict').
 * Validate the final staged state, so a replacement may overlap its original.
 * Every writer (including schedule/config changes and manual edits) must participate
 * in equivalent coordination. Reads outside the callback see only committed state.
 * Resolve only after commit; on error reject without any visible partial changes.
 * The callback must not be retried implicitly or used for external side effects.
 * Adapters must enforce clinic scope and may not weaken this contract.
 */
export interface AppointmentWriteCoordinator {
  runExclusive<T>(
    clinicId: string,
    operation: (unitOfWork: ClinicAppointmentUnitOfWork) => Promise<T>,
  ): Promise<T>;
}
