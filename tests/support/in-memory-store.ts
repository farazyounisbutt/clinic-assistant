import type { Appointment } from '../../src/appointments/models.js';
import { isActiveAppointmentStatus } from '../../src/appointments/lifecycle.js';
import type { Clinic } from '../../src/clinic/models.js';
import type {
  AppointmentRepository,
  AppointmentWriteCoordinator,
  ClinicAppointmentUnitOfWork,
} from '../../src/ports/repositories.js';
import type { BlockedSlot, WorkingHours } from '../../src/scheduling/models.js';
import { intervalsOverlap } from '../../src/scheduling/availability.js';
import { DomainError } from '../../src/shared/errors.js';

interface Seed {
  readonly clinics: readonly Clinic[];
  readonly workingHours: readonly WorkingHours[];
  readonly appointments?: readonly Appointment[];
  readonly blockedSlots?: readonly BlockedSlot[];
}

/** Test-only contract reference. Not durable or safe across processes/instances. */
export class InMemoryAppointmentStore
  implements AppointmentWriteCoordinator, AppointmentRepository
{
  private readonly records = new Map<string, readonly Appointment[]>();
  private readonly tails = new Map<string, Promise<void>>();
  private readonly seed: Seed;
  failNextCommit = false;

  constructor(seed: Seed) {
    this.seed = {
      clinics: seed.clinics.map((c) => ({ ...c })),
      workingHours: seed.workingHours.map((h) => ({
        ...h,
        ...(h.breaks ? { breaks: h.breaks.map((b) => ({ ...b })) } : {}),
      })),
      blockedSlots: (seed.blockedSlots ?? []).map((b) => ({ ...b })),
    };
    for (const c of seed.clinics)
      this.records.set(
        c.clinicId,
        (seed.appointments ?? [])
          .filter((a) => a.clinicId === c.clinicId)
          .map((a) => ({ ...a })),
      );
  }

  async findById(
    clinicId: string,
    appointmentId: string,
  ): Promise<Appointment | null> {
    const record = this.records
      .get(clinicId)
      ?.find((a) => a.appointmentId === appointmentId);
    return record ? { ...record } : null;
  }

  async listByDate(
    clinicId: string,
    date: string,
  ): Promise<readonly Appointment[]> {
    return (this.records.get(clinicId) ?? [])
      .filter((a) => a.appointmentDate === date)
      .map((a) => ({ ...a }));
  }

  async runExclusive<T>(
    clinicId: string,
    operation: (unit: ClinicAppointmentUnitOfWork) => Promise<T>,
  ): Promise<T> {
    const previous = this.tails.get(clinicId) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tails.set(clinicId, tail);
    await previous;
    try {
      const staged = new Map(
        (this.records.get(clinicId) ?? []).map((a) => [
          a.appointmentId,
          { ...a },
        ]),
      );
      let open = true;
      const guard = () => {
        if (!open)
          throw new DomainError('InvalidInput', 'Unit of work has closed');
      };
      const scope = (record: Appointment) => {
        guard();
        if (record.clinicId !== clinicId)
          throw new DomainError('InvalidInput', 'Cross-clinic write');
      };
      const clinic = this.seed.clinics.find((c) => c.clinicId === clinicId);
      const unit: ClinicAppointmentUnitOfWork = {
        clinic: clinic ? { ...clinic } : null,
        listWorkingHours: async () => {
          guard();
          return this.seed.workingHours
            .filter((h) => h.clinicId === clinicId)
            .map((h) => ({
              ...h,
              ...(h.breaks ? { breaks: h.breaks.map((b) => ({ ...b })) } : {}),
            }));
        },
        listBlockedSlots: async (date) => {
          guard();
          return (this.seed.blockedSlots ?? [])
            .filter((b) => b.clinicId === clinicId && b.date === date)
            .map((b) => ({ ...b }));
        },
        listAppointments: async (date) => {
          guard();
          return [...staged.values()]
            .filter((a) => a.appointmentDate === date)
            .map((a) => ({ ...a }));
        },
        findAppointment: async (id) => {
          guard();
          const record = staged.get(id);
          return record ? { ...record } : null;
        },
        insert: async (record) => {
          scope(record);
          if (staged.has(record.appointmentId))
            throw new DomainError('InvalidInput', 'Duplicate appointment ID');
          staged.set(record.appointmentId, { ...record });
        },
        replace: async (record) => {
          scope(record);
          if (!staged.has(record.appointmentId))
            throw new DomainError('AppointmentNotFound');
          staged.set(record.appointmentId, { ...record });
        },
      };
      let result: T;
      try {
        result = await operation(unit);
      } finally {
        open = false;
      }
      const active = [...staged.values()].filter((a) =>
        isActiveAppointmentStatus(a.status),
      );
      for (let i = 0; i < active.length; i++) {
        for (let j = i + 1; j < active.length; j++) {
          const a = active[i]!;
          const b = active[j]!;
          if (a.appointmentDate === b.appointmentDate && intervalsOverlap(a, b))
            throw new DomainError('SlotConflict');
        }
      }
      if (this.failNextCommit) {
        this.failNextCommit = false;
        throw new Error('Simulated commit failure');
      }
      this.records.set(clinicId, [...staged.values()]);
      return result;
    } finally {
      release();
      if (this.tails.get(clinicId) === tail) this.tails.delete(clinicId);
    }
  }
}
