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
 * Insert rejects duplicate IDs; replace rejects missing IDs or cross-clinic changes.
 */
export interface ClinicAppointmentUnitOfWork {
  readonly clinic: Clinic;
  listWorkingHours(): Promise<readonly WorkingHours[]>;
  listBlockedSlots(date: LocalDate): Promise<readonly BlockedSlot[]>;
  listAppointments(date: LocalDate): Promise<readonly Appointment[]>;
  findAppointment(appointmentId: string): Promise<Appointment | null>;
  insert(appointment: Appointment): Promise<void>;
  replace(appointment: Appointment): Promise<void>;
}

/**
 * Serializes every appointment write per clinic across all service instances.
 * The callback rechecks availability before insertion. All writes commit together
 * or none do; rescheduling must update the original and insert its replacement
 * together. Adapters must enforce clinic scope and may not weaken this contract.
 */
export interface AppointmentWriteCoordinator {
  runExclusive<T>(
    clinicId: string,
    operation: (unitOfWork: ClinicAppointmentUnitOfWork) => Promise<T>,
  ): Promise<T>;
}
