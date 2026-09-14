import type { Appointment, AppointmentStatus } from './models.js';
import { AppointmentSource } from './models.js';
import { assertAppointmentStatusTransition } from './lifecycle.js';
import { assertClinicConfiguration } from '../clinic/validation.js';
import type {
  AppointmentWriteCoordinator,
  ClinicAppointmentUnitOfWork,
} from '../ports/repositories.js';
import type { AppointmentIdGenerator, Clock } from '../ports/runtime.js';
import {
  assertSlotAvailable,
  getAvailableSlots,
} from '../scheduling/availability.js';
import type { SchedulingSnapshot } from '../scheduling/availability.js';
import {
  calendarDay,
  instantMilliseconds,
  timestampMilliseconds,
} from '../scheduling/time.js';
import { DomainError } from '../shared/errors.js';
import type { TimeRange } from '../shared/types.js';

export interface BookAppointment {
  readonly clinicId: string;
  readonly patientId: string;
  readonly patientName: string;
  readonly whatsappNumber: string;
  readonly appointmentDate: string;
  readonly startTime: string;
  readonly source: AppointmentSource;
  readonly createdBy: string;
  readonly reason?: string;
}

export interface RescheduleAppointment {
  readonly clinicId: string;
  readonly appointmentId: string;
  readonly appointmentDate: string;
  readonly startTime: string;
  readonly createdBy: string;
}

export interface TransitionAppointment {
  readonly clinicId: string;
  readonly appointmentId: string;
  readonly to: AppointmentStatus;
  /** Claimed internal actor context; a future boundary must authenticate it. */
  readonly actor: {
    readonly id: string;
    readonly role: 'Clerk' | 'Doctor' | 'Patient';
  };
}

function requireText(...values: readonly string[]): void {
  if (values.some((v) => typeof v !== 'string' || !v.trim()))
    throw new DomainError('InvalidInput', 'Required text is empty');
}

function validateBooking(input: BookAppointment): void {
  requireText(
    input.clinicId,
    input.patientId,
    input.patientName,
    input.createdBy,
  );
  if (
    !/^\+[1-9]\d{7,14}$/.test(input.whatsappNumber) ||
    !Object.values(AppointmentSource).includes(input.source) ||
    (input.reason !== undefined && typeof input.reason !== 'string')
  ) {
    throw new DomainError(
      'InvalidInput',
      'Invalid contact, source, or administrative reason',
    );
  }
}

async function readSnapshot(
  unit: ClinicAppointmentUnitOfWork,
  date: string,
): Promise<SchedulingSnapshot> {
  calendarDay(date);
  const [workingHours, blockedSlots, appointments] = await Promise.all([
    unit.listWorkingHours(),
    unit.listBlockedSlots(date),
    unit.listAppointments(date),
  ]);
  return { clinic: unit.clinic, workingHours, blockedSlots, appointments };
}

function assertScope(
  unit: ClinicAppointmentUnitOfWork,
  clinicId: string,
): void {
  assertClinicConfiguration(unit.clinic);
  if (unit.clinic.clinicId !== clinicId)
    throw new DomainError(
      'InvalidClinicConfiguration',
      'Coordinator returned a different clinic',
    );
}

async function findAppointment(
  unit: ClinicAppointmentUnitOfWork,
  clinicId: string,
  id: string,
): Promise<Appointment> {
  const record = await unit.findAppointment(id);
  if (!record || record.clinicId !== clinicId || record.appointmentId !== id)
    throw new DomainError('AppointmentNotFound');
  return record;
}

/** Runtime-neutral application service. The coordinator is the sole mutation path. */
export class AppointmentService {
  constructor(
    private readonly coordinator: AppointmentWriteCoordinator,
    private readonly clock: Clock,
    private readonly ids: AppointmentIdGenerator,
  ) {}

  /** Existing records remain readable/exportable regardless of subscription or horizon. */
  listAppointments(
    clinicId: string,
    date: string,
  ): Promise<readonly Appointment[]> {
    return this.coordinator.runExclusive(clinicId, async (unit) => {
      requireText(clinicId);
      assertScope(unit, clinicId);
      calendarDay(date);
      return (await unit.listAppointments(date))
        .filter(
          (record) =>
            record.clinicId === clinicId && record.appointmentDate === date,
        )
        .map((record) => ({ ...record }));
    });
  }

  availability(clinicId: string, date: string): Promise<readonly TimeRange[]> {
    requireText(clinicId);
    return this.coordinator.runExclusive(clinicId, async (unit) => {
      assertScope(unit, clinicId);
      return getAvailableSlots(
        await readSnapshot(unit, date),
        date,
        this.clock.now(),
      );
    });
  }

  book(input: BookAppointment): Promise<Appointment> {
    return this.coordinator.runExclusive(input.clinicId, async (unit) => {
      validateBooking(input);
      assertScope(unit, input.clinicId);
      const snapshot = await readSnapshot(unit, input.appointmentDate);
      const now = this.clock.now();
      const slot = assertSlotAvailable(
        snapshot,
        input.appointmentDate,
        input.startTime,
        now,
      );
      const record = this.newAppointment(input, slot, now);
      await unit.insert(record);
      return record;
    });
  }

  reschedule(input: RescheduleAppointment): Promise<Appointment> {
    return this.coordinator.runExclusive(input.clinicId, async (unit) => {
      requireText(input.clinicId, input.appointmentId, input.createdBy);
      assertScope(unit, input.clinicId);
      const original = await findAppointment(
        unit,
        input.clinicId,
        input.appointmentId,
      );
      if (
        original.status !== 'Scheduled' ||
        original.rescheduledTo !== null ||
        (original.appointmentDate === input.appointmentDate &&
          original.startTime === input.startTime)
      ) {
        throw new DomainError('InvalidReschedule');
      }
      const snapshot = await readSnapshot(unit, input.appointmentDate);
      const now = this.clock.now();
      const slot = assertSlotAvailable(
        {
          ...snapshot,
          appointments: snapshot.appointments.filter(
            (a) => a.appointmentId !== original.appointmentId,
          ),
        },
        input.appointmentDate,
        input.startTime,
        now,
      );
      const booking: BookAppointment = {
        clinicId: input.clinicId,
        patientId: original.patientId,
        patientName: original.patientName,
        whatsappNumber: original.whatsappNumber,
        appointmentDate: input.appointmentDate,
        startTime: input.startTime,
        source: original.source,
        createdBy: input.createdBy,
        ...(original.reason === undefined ? {} : { reason: original.reason }),
      };
      validateBooking(booking);
      const replacement = {
        ...this.newAppointment(booking, slot, now),
        rescheduledFrom: original.appointmentId,
      };
      // Insertion must succeed before even staging the original's new status.
      await unit.insert(replacement);
      await unit.replace({
        ...original,
        status: 'Rescheduled',
        rescheduledTo: replacement.appointmentId,
      });
      return replacement;
    });
  }

  transition(input: TransitionAppointment): Promise<Appointment> {
    return this.coordinator.runExclusive(input.clinicId, async (unit) => {
      requireText(input.clinicId, input.appointmentId, input.actor.id);
      assertScope(unit, input.clinicId);
      const record = await findAppointment(
        unit,
        input.clinicId,
        input.appointmentId,
      );
      if (
        input.to === 'Rescheduled' ||
        (input.to === 'NoShow' && input.actor.role !== 'Clerk')
      ) {
        throw new DomainError('InvalidAppointmentTransition');
      }
      assertAppointmentStatusTransition(record.status, input.to);
      const now = this.clock.now();
      const nowMs = instantMilliseconds(now);
      const bookedAt = timestampMilliseconds(record.bookedAt);
      const lastEvent =
        record.checkedInAt === null
          ? bookedAt
          : timestampMilliseconds(record.checkedInAt);
      if (lastEvent < bookedAt || nowMs < lastEvent)
        throw new DomainError(
          'InvalidAppointmentTransition',
          'Event time cannot precede previous event',
        );
      const updated: Appointment = {
        ...record,
        status: input.to,
        checkedInAt:
          input.to === 'CheckedIn' ? now.toISOString() : record.checkedInAt,
        completedAt:
          input.to === 'Completed' ? now.toISOString() : record.completedAt,
        cancelledAt:
          input.to === 'Cancelled' ? now.toISOString() : record.cancelledAt,
      };
      await unit.replace(updated);
      return updated;
    });
  }

  private newAppointment(
    input: BookAppointment,
    slot: TimeRange,
    now: Date,
  ): Appointment {
    const appointmentId = this.ids.next();
    requireText(appointmentId);
    return {
      appointmentId,
      clinicId: input.clinicId,
      patientId: input.patientId,
      patientName: input.patientName,
      whatsappNumber: input.whatsappNumber,
      appointmentDate: input.appointmentDate,
      ...slot,
      source: input.source,
      createdBy: input.createdBy,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      status: 'Scheduled',
      bookedAt: now.toISOString(),
      checkedInAt: null,
      completedAt: null,
      cancelledAt: null,
      rescheduledFrom: null,
      rescheduledTo: null,
    };
  }
}
