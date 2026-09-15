import { GoogleServiceAccountTokens } from '../sheets/auth.js';
import { GoogleSheetsClient } from '../sheets/client.js';
import { GoogleSheetsProjection } from '../sheets/projection.js';
import { configuredTarget } from '../sheets/configuration.js';
import type { GoogleProjectionEnvironment } from '../sheets/configuration.js';
import { ProjectionFailure } from '../../projection/errors.js';
import type { ProjectionFailureCategory } from '../../projection/errors.js';
import { DurableObject } from 'cloudflare:workers';
import { AppointmentService } from '../../appointments/service.js';
import type {
  BookAppointment,
  RescheduleAppointment,
  TransitionAppointment,
} from '../../appointments/service.js';
import type { ClinicConfiguration } from '../../ports/projection.js';
import { DomainError } from '../../shared/errors.js';
import type { DomainErrorCode } from '../../shared/errors.js';
import { SqliteClinicRepository } from './repository.js';

export interface WorkerEnv extends GoogleProjectionEnvironment {
  CLINICS: DurableObjectNamespace<ClinicDurableObject>;
}
export type ClinicResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      error: {
        code:
          DomainErrorCode | ProjectionFailureCategory | 'StorageUnavailable';
        message: string;
      };
    };
const clock = { now: () => new Date() };
/** Internal RPC only. No HTTP mutation routes until an authenticated boundary exists. */
export class ClinicDurableObject extends DurableObject<WorkerEnv> {
  private google: GoogleSheetsProjection | undefined;
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
          error instanceof DomainError || error instanceof ProjectionFailure
            ? {
                code:
                  error instanceof DomainError ? error.code : error.category,
                message: error.message,
              }
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
  private projection(clinicId: string): GoogleSheetsProjection {
    if (!this.google) {
      const target = configuredTarget(this.env, clinicId);
      if (
        !this.env.GOOGLE_SERVICE_ACCOUNT_EMAIL ||
        !this.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
      )
        throw new ProjectionFailure('Configuration');
      const tokens = new GoogleServiceAccountTokens(
        {
          email: this.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
          privateKey: this.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
        },
        clock,
      );
      this.google = new GoogleSheetsProjection(
        target,
        new GoogleSheetsClient(tokens),
      );
    }
    return this.google;
  }
  private drain(repo: SqliteClinicRepository): Promise<void> {
    // Resolve runtime configuration inside delivery, after booking has committed.
    return repo.flushProjection({
      applySnapshot: (snapshot) =>
        this.projection(repo.clinicId).applySnapshot(snapshot),
    });
  }
  private project(repo: SqliteClinicRepository): void {
    this.ctx.waitUntil(this.drain(repo));
  }
  validateProjection(clinicId: string) {
    return this.call(clinicId, (repo) =>
      repo.manageProjection(() => this.projection(clinicId).validate()),
    );
  }
  bootstrapProjection(clinicId: string) {
    return this.call(clinicId, (repo) =>
      repo.manageProjection(() => this.projection(clinicId).bootstrap()),
    );
  }
  drainProjection(clinicId: string) {
    return this.call(clinicId, async (repo) => {
      await this.drain(repo);
      return repo.readProjectionStatus();
    });
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
    if (row) await this.drain(this.repo(row.clinic_id));
  }
}
export default {
  fetch(): Response {
    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<WorkerEnv>;
