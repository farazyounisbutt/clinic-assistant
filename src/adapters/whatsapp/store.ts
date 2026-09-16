import type { Clock } from '../../ports/runtime.js';
import type { SqliteClinicRepository } from '../cloudflare/repository.js';
import { scheduleClinicAlarm } from '../cloudflare/alarms.js';
import { converse } from './conversation.js';
import type { Conversation, Outcome } from './conversation.js';
import { converseClerk } from './clerk.js';
import type { ClerkConversation, ClerkOutcome } from './clerk.js';
import { noOperators } from '../../ports/operators.js';
import type { OperatorDirectory } from '../../ports/operators.js';
import { MetaFailure } from './models.js';
import type { Batch, Incoming, Message, Messenger } from './models.js';

type InboxRow = {
  id: string;
  payload: string;
  phone_id: string;
  received_at: number;
  attempts: number;
  next_attempt_at: number;
};
type OutboxRow = {
  id: string;
  phone_id: string;
  recipient: string;
  payload: string;
  state: string;
  attempts: number;
  expires_at: number;
  next_attempt_at: number;
};
const WINDOW_MS = 24 * 60 * 60_000;

export class WhatsAppStore {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly repo: SqliteClinicRepository,
    private readonly clock: Clock,
    private readonly operators: OperatorDirectory = noOperators,
  ) {}
  /** The caller authenticated and validated the entire envelope before any write. */
  async enqueue(batch: Batch): Promise<void> {
    await this.repo.coordinate(() =>
      this.storage.transaction(async (transaction) => {
        const now = this.clock.now().getTime();
        const alarm = await transaction.getAlarm();
        if (alarm === null || alarm > now + 1000)
          await transaction.setAlarm(now + 1000);
        for (const message of batch.messages) {
          const timely =
            message.timestamp > now - WINDOW_MS &&
            message.timestamp <= now + 300_000;
          this.storage.sql.exec(
            'INSERT OR IGNORE INTO wa_inbox(id,payload,phone_id,received_at,next_attempt_at) VALUES(?,?,?,?,?)',
            message.id,
            timely ? JSON.stringify(message) : null,
            timely ? batch.phoneNumberId : null,
            now,
            now,
          );
        }
        for (const status of batch.statuses) {
          this.storage.sql.exec(
            `INSERT INTO wa_status(id,phone_id,recipient,status,timestamp,expires_at) VALUES(?,?,?,?,?,?)
          ON CONFLICT(id,phone_id,recipient) DO UPDATE SET status=excluded.status,timestamp=excluded.timestamp
          WHERE excluded.timestamp>=wa_status.timestamp AND wa_status.status!='read'
          AND (excluded.status='read' OR wa_status.status!='delivered') AND (excluded.status!='sent' OR wa_status.status='sent')`,
            status.id,
            batch.phoneNumberId,
            status.recipient,
            status.status,
            status.timestamp,
            now + WINDOW_MS,
          );
        }
        this.applyStatuses();
      }),
    );
  }
  private applyStatuses(): void {
    const statuses = this.storage.sql
      .exec<{
        id: string;
        phone_id: string;
        recipient: string;
        status: string;
        timestamp: number;
      }>('SELECT id,phone_id,recipient,status,timestamp FROM wa_status')
      .toArray();
    for (const s of statuses) {
      const match = this.storage.sql
        .exec<{ id: string }>(
          'SELECT id FROM wa_outbox WHERE provider_id=? AND phone_id=? AND recipient=?',
          s.id,
          s.phone_id,
          s.recipient,
        )
        .toArray()[0];
      if (!match) continue;
      this.storage.sql.exec(
        `UPDATE wa_outbox SET delivery_status=?,delivery_at=? WHERE id=? AND
        (delivery_at IS NULL OR delivery_at<=?) AND (delivery_status IS NULL OR delivery_status!='read')
        AND (?='read' OR delivery_status IS NULL OR delivery_status!='delivered') AND (?!='sent' OR delivery_status IS NULL OR delivery_status='sent')`,
        s.status,
        s.timestamp,
        match.id,
        s.timestamp,
        s.status,
        s.status,
      );
      this.storage.sql.exec(
        'DELETE FROM wa_status WHERE id=? AND phone_id=? AND recipient=?',
        s.id,
        s.phone_id,
        s.recipient,
      );
    }
  }
  private async processOne(): Promise<boolean> {
    let job: InboxRow | undefined;
    let actorId = 'whatsapp-patient';
    try {
      return await this.repo
        .runWithCommit(
          async (unit) => {
            job = this.storage.sql
              .exec<InboxRow>(
                'SELECT * FROM wa_inbox WHERE payload IS NOT NULL ORDER BY sequence LIMIT 1',
              )
              .toArray()[0];
            if (!job || job.next_attempt_at > this.clock.now().getTime())
              return null;
            const incoming = JSON.parse(job.payload) as Incoming;
            const row = this.storage.sql
              .exec<{ record: string }>(
                'SELECT record FROM wa_conversations WHERE sender=?',
                incoming.sender,
              )
              .toArray()[0];
            if (incoming.timestamp <= this.clock.now().getTime() - WINDOW_MS)
              return { job, outcome: null };
            const prior = row
              ? (JSON.parse(row.record) as Conversation | ClerkConversation)
              : null;
            const operator = this.operators.resolve(
              this.repo.clinicId,
              incoming.sender,
            );
            const isClerk = prior && 'kind' in prior && prior.kind === 'clerk';
            const records = this.repo.exportRecords();
            const outcome =
              operator?.role === 'Clerk'
                ? await converseClerk(
                    isClerk ? (prior as ClerkConversation) : null,
                    incoming,
                    records,
                    unit,
                    this.clock,
                    operator,
                  )
                : await converse(
                    isClerk ? null : (prior as Conversation | null),
                    incoming,
                    records,
                    unit,
                    this.clock,
                  );
            if (operator?.role === 'Clerk') actorId = operator.operatorId;
            return { job, outcome };
          },
          (result) => {
            if (!result) return;
            this.complete(result.job, result.outcome);
          },
          () => actorId,
        )
        .then((result) => result !== null);
    } catch {
      // Keep acknowledged work durable; back off infrastructure failures, without recording input/errors in logs.
      if (job)
        await this.repo.coordinate(async () => {
          this.storage.sql.exec(
            'UPDATE wa_inbox SET attempts=attempts+1,next_attempt_at=? WHERE id=? AND payload IS NOT NULL',
            this.clock.now().getTime() +
              Math.min(3_600_000, 30_000 * 2 ** Math.min(job!.attempts, 7)),
            job!.id,
          );
        });
      return false;
    }
  }
  private complete(
    job: InboxRow,
    outcome: Outcome | ClerkOutcome | null,
  ): void {
    if (outcome) {
      const state = outcome.state;
      this.storage.sql.exec(
        'INSERT INTO wa_conversations(sender,record,expires_at) VALUES(?,?,?) ON CONFLICT(sender) DO UPDATE SET record=excluded.record,expires_at=excluded.expires_at',
        state.sender,
        JSON.stringify(state),
        state.expiresAt,
      );
      this.storage.sql.exec(
        'INSERT INTO wa_outbox(id,phone_id,recipient,payload,next_attempt_at,created_at,expires_at) VALUES(?,?,?,?,?,?,?)',
        job.id,
        job.phone_id,
        state.sender,
        JSON.stringify({
          ...outcome.message,
          ...('kind' in state && state.kind === 'clerk'
            ? { operatorId: state.operatorId }
            : {}),
        }),
        this.clock.now().getTime(),
        this.clock.now().getTime(),
        Math.min(
          (JSON.parse(job.payload) as Incoming).timestamp,
          this.clock.now().getTime(),
        ) + WINDOW_MS,
      );
    }
    // Only the idempotency tombstone remains; free text is removed in the same commit.
    this.storage.sql.exec(
      'UPDATE wa_inbox SET payload=NULL,phone_id=NULL WHERE id=?',
      job.id,
    );
  }
  async drain(messenger: Messenger): Promise<void> {
    await this.repo.manageMessaging(async () => {
      await this.repo.coordinate(async () => {
        // An interrupted HTTP request may already have delivered. Never replay it automatically.
        this.storage.sql.exec(
          "UPDATE wa_outbox SET state='unknown',payload=NULL,last_error='Uncertain' WHERE state='attempting'",
        );
      });
      const started = this.clock.now().getTime();
      for (
        let i = 0;
        i < 20 && this.clock.now().getTime() - started < 20_000;
        i++
      )
        if (!(await this.processOne())) break;
      for (
        let i = 0;
        i < 20 && this.clock.now().getTime() - started < 20_000;
        i++
      ) {
        const job = await this.repo.coordinate(async () => {
          // Preserve ordering per recipient: a rate-limited older response blocks newer responses to that recipient only.
          const row = this.storage.sql
            .exec<OutboxRow>(
              `SELECT * FROM wa_outbox o WHERE state='pending' AND next_attempt_at<=? AND NOT EXISTS(
            SELECT 1 FROM wa_outbox earlier WHERE earlier.recipient=o.recipient AND earlier.state='pending' AND earlier.rowid<o.rowid
          ) ORDER BY rowid LIMIT 1`,
              this.clock.now().getTime(),
            )
            .toArray()[0];
          if (row)
            this.storage.sql.exec(
              "UPDATE wa_outbox SET state='attempting',attempts=attempts+1 WHERE id=?",
              row.id,
            );
          return row;
        });
        if (!job) break;
        let provider: string | null = null;
        let failure: MetaFailure | null = null;
        if (job.expires_at <= this.clock.now().getTime())
          failure = new MetaFailure('Rejected');
        else
          try {
            const payload = JSON.parse(job.payload) as Message & {
              operatorId?: string;
            };
            if (payload.operatorId) {
              const operator = this.operators.resolve(
                this.repo.clinicId,
                job.recipient,
              );
              if (
                operator?.role !== 'Clerk' ||
                operator.operatorId !== payload.operatorId
              )
                throw new MetaFailure('Configuration');
            }
            provider = await messenger.send(
              job.phone_id,
              job.recipient,
              payload,
            );
          } catch (error) {
            failure =
              error instanceof MetaFailure
                ? error
                : new MetaFailure('Uncertain');
          }
        await this.repo.coordinate(async () =>
          this.storage.transactionSync(() => {
            const retry =
              failure?.category === 'RateLimited' && job.attempts < 2;
            const state = retry
              ? 'pending'
              : failure
                ? failure.category === 'Uncertain'
                  ? 'unknown'
                  : 'failed'
                : 'sent';
            this.storage.sql.exec(
              'UPDATE wa_outbox SET state=?,payload=?,provider_id=?,last_error=?,next_attempt_at=? WHERE id=?',
              state,
              retry ? job.payload : null,
              provider,
              failure?.category ?? null,
              this.clock.now().getTime() +
                Math.max(1000 * 2 ** job.attempts, failure?.retryAfterMs ?? 0),
              job.id,
            );
            this.applyStatuses();
          }),
        );
      }
      await this.repo.coordinate(async () => {
        const now = this.clock.now().getTime();
        this.storage.sql.exec(
          'DELETE FROM wa_conversations WHERE expires_at<=?',
          now,
        );
        this.storage.sql.exec('DELETE FROM wa_status WHERE expires_at<=?', now);
        this.storage.sql.exec(
          "DELETE FROM wa_outbox WHERE state NOT IN ('pending','attempting') AND created_at<=?",
          now - 7 * WINDOW_MS,
        );
        await scheduleClinicAlarm(this.storage, now);
      });
    });
  }
}
