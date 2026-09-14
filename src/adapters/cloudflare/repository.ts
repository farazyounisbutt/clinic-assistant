import type { Appointment } from '../../appointments/models.js';
import { isActiveAppointmentStatus } from '../../appointments/lifecycle.js';
import type {
  AppointmentRepository,
  AppointmentWriteCoordinator,
  ClinicAppointmentUnitOfWork,
} from '../../ports/repositories.js';
import type {
  ActivityEvent,
  ClinicConfiguration,
  ClinicRecords,
  ClinicRecordProjection,
  ClinicProjectionSnapshot,
} from '../../ports/projection.js';
import type { Clock } from '../../ports/runtime.js';
import { projectionSnapshot } from '../../projection/sheets.js';
import { intervalsOverlap } from '../../scheduling/availability.js';
import { DomainError } from '../../shared/errors.js';
import { migrate } from './schema.js';
import { cleanConfiguration } from './configuration.js';

class Mutex {
  private tail = Promise.resolve();
  async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
const locks = new WeakMap<
  DurableObjectStorage,
  { writes: Mutex; projection: Mutex }
>();
type RecordTable =
  | 'clinic_settings'
  | 'working_hours'
  | 'blocked_slots'
  | 'patients'
  | 'appointments'
  | 'activity_log';

/** One instance per named clinic DO. All writers share the storage-scoped mutex. */
export class SqliteClinicRepository
  implements AppointmentWriteCoordinator, AppointmentRepository
{
  private readonly locks;
  constructor(
    private readonly storage: DurableObjectStorage,
    readonly clinicId: string,
    private readonly clock: Clock,
  ) {
    if (!clinicId.trim()) throw new DomainError('InvalidInput');
    migrate(storage, clinicId);
    let shared = locks.get(storage);
    if (!shared) {
      shared = { writes: new Mutex(), projection: new Mutex() };
      locks.set(storage, shared);
    }
    this.locks = shared;
  }
  private scope(clinicId: string): void {
    if (clinicId !== this.clinicId)
      throw new DomainError('InvalidInput', 'Cross-clinic operation');
  }
  private records<T>(table: RecordTable): T[] {
    return this.storage.sql
      .exec<{ record: string }>(`SELECT record FROM ${table} ORDER BY id`)
      .toArray()
      .map((row) => JSON.parse(row.record) as T);
  }
  private put(table: RecordTable, id: string, record: unknown): void {
    this.storage.sql.exec(
      `INSERT INTO ${table}(id, record) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET record=excluded.record`,
      id,
      JSON.stringify(record),
    );
  }
  exportRecords(): ClinicRecords {
    return {
      clinic:
        this.records<ClinicConfiguration['clinic']>('clinic_settings')[0] ??
        null,
      workingHours: this.records('working_hours'),
      blockedSlots: this.records('blocked_slots'),
      patients: this.records('patients'),
      appointments: this.records('appointments'),
      activity: this.records('activity_log'),
    };
  }
  /** RPC-facing reads wait for any in-flight transaction to finish. */
  readRecords(): Promise<ClinicRecords> {
    return this.locks.writes.run(async () => this.exportRecords());
  }
  readProjectionStatus() {
    return this.locks.writes.run(async () => this.projectionStatus());
  }
  async findById(
    clinicId: string,
    appointmentId: string,
  ): Promise<Appointment | null> {
    this.scope(clinicId);
    return this.locks.writes.run(async () => {
      const row = this.storage.sql
        .exec<{ record: string }>(
          'SELECT record FROM appointments WHERE id=?',
          appointmentId,
        )
        .toArray()[0];
      return row ? (JSON.parse(row.record) as Appointment) : null;
    });
  }
  async listByDate(
    clinicId: string,
    date: string,
  ): Promise<readonly Appointment[]> {
    this.scope(clinicId);
    return this.locks.writes.run(async () =>
      this.storage.sql
        .exec<{ record: string }>(
          'SELECT record FROM appointments WHERE date=? ORDER BY start, id',
          date,
        )
        .toArray()
        .map((r) => JSON.parse(r.record) as Appointment),
    );
  }
  async configure(input: ClinicConfiguration, actorId: string): Promise<void> {
    const config = cleanConfiguration(input, this.clinicId);
    await this.locks.writes.run(async () => {
      await this.commit(actorId, (event) => {
        this.put('clinic_settings', this.clinicId, config.clinic);
        this.storage.sql.exec('DELETE FROM working_hours');
        this.storage.sql.exec('DELETE FROM blocked_slots');
        for (const h of config.workingHours)
          this.put(
            'working_hours',
            `${h.dayOfWeek}:${h.startTime}:${h.endTime}`,
            h,
          );
        for (const b of config.blockedSlots) this.put('blocked_slots', b.id, b);
        event(
          'ConfigurationUpdated',
          null,
          'Scheduling configuration replaced',
        );
      });
    });
  }
  asActor(actorId: string): AppointmentWriteCoordinator {
    return {
      runExclusive: (clinicId, operation) =>
        this.execute(clinicId, operation, actorId),
    };
  }
  runExclusive<T>(
    clinicId: string,
    operation: (unit: ClinicAppointmentUnitOfWork) => Promise<T>,
  ): Promise<T> {
    return this.execute(clinicId, operation, 'system');
  }
  private async execute<T>(
    clinicId: string,
    operation: (unit: ClinicAppointmentUnitOfWork) => Promise<T>,
    actorId: string,
  ): Promise<T> {
    this.scope(clinicId);
    return this.locks.writes.run(async () => {
      const snapshot = this.exportRecords();
      const original = new Map(
        snapshot.appointments.map((a) => [a.appointmentId, a]),
      );
      const staged = new Map(original);
      let open = true;
      const guard = () => {
        if (!open) throw new DomainError('InvalidInput', 'Closed unit of work');
      };
      const copy = (a: Appointment): Appointment => {
        // Explicit operational field allowlist: never persist unknown input properties.
        const {
          appointmentId,
          clinicId,
          patientId,
          patientName,
          whatsappNumber,
          appointmentDate,
          startTime,
          endTime,
          source,
          status,
          bookedAt,
          checkedInAt,
          completedAt,
          cancelledAt,
          rescheduledFrom,
          rescheduledTo,
          createdBy,
          reason,
        } = a;
        return {
          appointmentId,
          clinicId,
          patientId,
          patientName,
          whatsappNumber,
          appointmentDate,
          startTime,
          endTime,
          source,
          status,
          bookedAt,
          checkedInAt,
          completedAt,
          cancelledAt,
          rescheduledFrom,
          rescheduledTo,
          createdBy,
          ...(reason === undefined ? {} : { reason }),
        };
      };
      const unit: ClinicAppointmentUnitOfWork = {
        clinic: snapshot.clinic,
        listWorkingHours: async () => {
          guard();
          return structuredClone(snapshot.workingHours);
        },
        listBlockedSlots: async (date) => {
          guard();
          return snapshot.blockedSlots
            .filter((b) => b.date === date)
            .map((b) => ({ ...b }));
        },
        listAppointments: async (date) => {
          guard();
          return [...staged.values()]
            .filter((a) => a.appointmentDate === date)
            .map(copy);
        },
        findAppointment: async (id) => {
          guard();
          const a = staged.get(id);
          return a ? copy(a) : null;
        },
        insert: async (a) => {
          guard();
          this.scope(a.clinicId);
          if (staged.has(a.appointmentId))
            throw new DomainError('InvalidInput', 'Duplicate appointment ID');
          staged.set(a.appointmentId, copy(a));
        },
        replace: async (a) => {
          guard();
          this.scope(a.clinicId);
          if (!staged.has(a.appointmentId))
            throw new DomainError('AppointmentNotFound');
          staged.set(a.appointmentId, copy(a));
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
      for (let i = 0; i < active.length; i++)
        for (let j = i + 1; j < active.length; j++) {
          if (
            active[i]!.appointmentDate === active[j]!.appointmentDate &&
            intervalsOverlap(active[i]!, active[j]!)
          )
            throw new DomainError('SlotConflict');
        }
      const changed = [...staged.values()].filter(
        (a) =>
          JSON.stringify(a) !== JSON.stringify(original.get(a.appointmentId)),
      );
      if (changed.length)
        await this.commit(actorId, (event) => {
          for (const a of changed) {
            const before = original.get(a.appointmentId);
            this.put('appointments', a.appointmentId, a);
            if (!before && !a.rescheduledFrom) {
              const patient = snapshot.patients.find(
                (p) => p.patientId === a.patientId,
              );
              this.put('patients', a.patientId, {
                clinicId,
                patientId: a.patientId,
                name: a.patientName,
                whatsappNumber: a.whatsappNumber,
                createdAt: patient?.createdAt ?? a.bookedAt,
              });
            }
            const action = !before
              ? 'AppointmentCreated'
              : `Appointment${a.status}`;
            event(
              action,
              a.appointmentId,
              JSON.stringify({
                from: before?.status ?? null,
                to: a.status,
                rescheduledFrom: a.rescheduledFrom,
                rescheduledTo: a.rescheduledTo,
              }),
            );
          }
        });
      return result;
    });
  }
  private async commit(
    actorId: string,
    mutate: (
      event: (
        action: string,
        appointmentId: string | null,
        detail: string,
      ) => void,
    ) => void,
  ): Promise<void> {
    if (!actorId.trim())
      throw new DomainError('InvalidInput', 'Actor required');
    const now = this.clock.now();
    await this.storage.transaction(async (transaction) => {
      // Alarm and outbox are in the same transaction; a crash cannot orphan work.
      const alarm = await transaction.getAlarm();
      if (alarm === null || alarm > now.getTime() + 1000)
        await transaction.setAlarm(now.getTime() + 1000);
      this.storage.sql.exec(
        'UPDATE metadata SET revision=revision+1 WHERE singleton=1',
      );
      const revision = this.metadata().revision;
      let sequence = 0;
      mutate((action, appointmentId, detail) => {
        const event: ActivityEvent = {
          eventId: `${revision}:${++sequence}`,
          clinicId: this.clinicId,
          timestamp: now.toISOString(),
          actorId,
          action,
          appointmentId,
          detail,
        };
        this.put('activity_log', event.eventId, event);
      });
      const snapshot = projectionSnapshot(
        this.clinicId,
        revision,
        this.exportRecords(),
      );
      this.storage.sql.exec(
        'INSERT INTO projection_outbox(revision, snapshot, next_attempt_at) VALUES (?, ?, ?)',
        revision,
        JSON.stringify(snapshot),
        now.getTime(),
      );
    });
  }
  private metadata() {
    return this.storage.sql
      .exec<{ revision: number; delivered_revision: number }>(
        'SELECT revision, delivered_revision FROM metadata WHERE singleton=1',
      )
      .one();
  }
  projectionStatus() {
    const rows = this.storage.sql
      .exec<{ attempts: number; next_attempt_at: number }>(
        'SELECT attempts, next_attempt_at FROM projection_outbox ORDER BY revision',
      )
      .toArray();
    return {
      pending: rows.length,
      failed: rows.filter((r) => r.attempts > 0).length,
      nextAttemptAt: rows[0]?.next_attempt_at ?? null,
      lastDeliveredRevision: this.metadata().delivered_revision,
    };
  }
  async flushProjection(projection: ClinicRecordProjection): Promise<void> {
    await this.locks.projection.run(async () => {
      // Bound each invocation; an alarm continues larger backlogs.
      for (let count = 0; count < 25; count++) {
        const job = await this.locks.writes.run(
          async () =>
            this.storage.sql
              .exec<{
                revision: number;
                snapshot: string;
                attempts: number;
                next_attempt_at: number;
              }>(
                'SELECT revision, snapshot, attempts, next_attempt_at FROM projection_outbox ORDER BY revision LIMIT 1',
              )
              .toArray()[0],
        );
        if (!job || job.next_attempt_at > this.clock.now().getTime()) break;
        let delivered = false;
        try {
          await projection.applySnapshot(
            JSON.parse(job.snapshot) as ClinicProjectionSnapshot,
          );
          delivered = true;
        } catch {
          /* Store only a safe classification, never remote error payloads. */
        }
        await this.locks.writes.run(async () => {
          this.storage.transactionSync(() => {
            if (delivered) {
              this.storage.sql.exec(
                'DELETE FROM projection_outbox WHERE revision=?',
                job.revision,
              );
              this.storage.sql.exec(
                'UPDATE metadata SET delivered_revision=? WHERE singleton=1',
                job.revision,
              );
            } else {
              const delay = Math.min(
                3_600_000,
                30_000 * 2 ** Math.min(job.attempts, 7),
              );
              this.storage.sql.exec(
                "UPDATE projection_outbox SET attempts=attempts+1, next_attempt_at=?, last_error='ProjectionUnavailable' WHERE revision=?",
                this.clock.now().getTime() + delay,
                job.revision,
              );
            }
          });
        });
        if (!delivered) break;
      }
      await this.locks.writes.run(async () => {
        const next = this.projectionStatus().nextAttemptAt;
        if (next === null) await this.storage.deleteAlarm();
        else
          await this.storage.setAlarm(
            Math.max(next, this.clock.now().getTime() + 1000),
          );
      });
    });
  }
}
