import { DurableObject } from 'cloudflare:workers';
import { AppointmentService } from '../../appointments/service.js';
import type {
  BookAppointment,
  RescheduleAppointment,
  TransitionAppointment,
} from '../../appointments/service.js';
import type {
  ClinicConfiguration,
  ClinicRecordProjection,
} from '../../ports/projection.js';
import { DomainError } from '../../shared/errors.js';
import type { DomainErrorCode } from '../../shared/errors.js';
import { SqliteClinicRepository } from './repository.js';

export interface WorkerEnv {
  CLINICS: DurableObjectNamespace<ClinicDurableObject>;
}
export type ClinicResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      error: { code: DomainErrorCode | 'StorageUnavailable'; message: string };
    };
const clock = { now: () => new Date() };
const unavailableProjection: ClinicRecordProjection = {
  applySnapshot: async () => {
    throw new Error('Projection not configured');
  },
};

/** Internal RPC only. No HTTP mutation routes until an authenticated boundary exists. */
export class ClinicDurableObject extends DurableObject<WorkerEnv> {
  private repository: SqliteClinicRepository | undefined;
  private repo(clinicId: string): SqliteClinicRepository {
    if (
      !clinicId.trim() ||
      !this.env.CLINICS.idFromName(clinicId).equals(this.ctx.id)
    )
      throw new DomainError(
        'InvalidInput',
        'Clinic does not match object name',
      );
    this.repository ??= new SqliteClinicRepository(
      this.ctx.storage,
      clinicId,
      clock,
    );
    return this.repository;
  }
  private async call<T>(
    clinicId: string,
    operation: (repo: SqliteClinicRepository) => Promise<T>,
  ): Promise<ClinicResult<T>> {
    try {
      return { ok: true, value: await operation(this.repo(clinicId)) };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof DomainError
            ? { code: error.code, message: error.message }
            : {
                code: 'StorageUnavailable',
                message: 'Clinic operation failed',
              },
      };
    }
  }
  private service(
    repo: SqliteClinicRepository,
    actor: string,
  ): AppointmentService {
    return new AppointmentService(repo.asActor(actor), clock, {
      next: () => crypto.randomUUID(),
    });
  }
  private project(repo: SqliteClinicRepository): void {
    this.ctx.waitUntil(repo.flushProjection(unavailableProjection));
  }
  configure(input: ClinicConfiguration, actorId: string) {
    return this.call(input.clinic.clinicId, async (repo) => {
      await repo.configure(input, actorId);
      this.project(repo);
    });
  }
  book(input: BookAppointment) {
    return this.call(input.clinicId, async (repo) => {
      const result = await this.service(repo, input.createdBy).book(input);
      this.project(repo);
      return result;
    });
  }
  reschedule(input: RescheduleAppointment) {
    return this.call(input.clinicId, async (repo) => {
      const result = await this.service(repo, input.createdBy).reschedule(
        input,
      );
      this.project(repo);
      return result;
    });
  }
  transition(input: TransitionAppointment) {
    return this.call(input.clinicId, async (repo) => {
      const result = await this.service(repo, input.actor.id).transition(input);
      this.project(repo);
      return result;
    });
  }
  availability(clinicId: string, date: string) {
    return this.call(clinicId, (repo) =>
      this.service(repo, 'system').availability(clinicId, date),
    );
  }
  appointments(clinicId: string, date: string) {
    return this.call(clinicId, (repo) => repo.listByDate(clinicId, date));
  }
  exportRecords(clinicId: string) {
    return this.call(clinicId, (repo) => repo.readRecords());
  }
  projectionStatus(clinicId: string) {
    return this.call(clinicId, (repo) => repo.readProjectionStatus());
  }
  override async alarm(): Promise<void> {
    const row = this.ctx.storage.sql
      .exec<{ clinic_id: string }>(
        'SELECT clinic_id FROM metadata WHERE singleton=1',
      )
      .toArray()[0];
    if (row)
      await this.repo(row.clinic_id).flushProjection(unavailableProjection);
  }
}
export default {
  fetch(): Response {
    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<WorkerEnv>;
