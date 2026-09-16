/** Development-only entrypoint. The ordinary Worker never imports these routes. */
import production, {
  ClinicDurableObject as ProductionClinic,
} from './worker.js';
import type { WorkerEnv } from './worker.js';
import type { Batch } from '../whatsapp/models.js';
import { SqliteClinicRepository } from './repository.js';
import type { Conversation } from '../whatsapp/conversation.js';
import type { ClinicConfiguration } from '../../ports/projection.js';

export const TEST_CLINIC = 'integration_test_clinic';
export interface DevelopmentEnv extends WorkerEnv {
  readonly DEVELOPMENT_MODE?: string;
  readonly DEVELOPMENT_ADMIN_TOKEN?: string;
}
const clock = { now: () => new Date() };
const mask = (value: string) => `***${value.slice(-4)}`;
const replayKey = 'development-last-message';
interface Replay {
  readonly batch: Batch;
  readonly expiresAt: number;
}

export class ClinicDurableObject extends ProductionClinic {
  private developmentRepository() {
    if (!this.env.CLINICS.idFromName(TEST_CLINIC).equals(this.ctx.id))
      throw new Error('Test clinic only');
    return new SqliteClinicRepository(this.ctx.storage, TEST_CLINIC, clock);
  }
  override async receiveWhatsApp(clinicId: string, batch: Batch) {
    this.developmentRepository();
    const result = await super.receiveWhatsApp(clinicId, batch);
    if (result.ok && batch.messages.length)
      await this.developmentRepository().coordinate(async () => {
        await this.ctx.storage.put<Replay>(replayKey, {
          batch: {
            phoneNumberId: batch.phoneNumberId,
            messages: [batch.messages[0]!],
            statuses: [],
          },
          expiresAt: Date.now() + 600_000,
        });
      });
    return result;
  }
  async inspectDevelopment() {
    const repo = this.developmentRepository();
    return repo.coordinate(async () => {
      const records = repo.exportRecords();
      const conversations = this.ctx.storage.sql
        .exec<{ record: string }>('SELECT record FROM wa_conversations')
        .toArray()
        .map((row) => {
          const s = JSON.parse(row.record) as Conversation;
          return {
            identity: mask(s.sender),
            workflow: s.workflow,
            step: s.step,
            version: s.version,
            date: s.date,
            slot: s.slot,
            appointmentId: s.appointmentId,
            lastInteractionAt: s.lastInteractionAt,
          };
        });
      const inbox = this.ctx.storage.sql
        .exec(
          'SELECT COUNT(*) AS total, SUM(CASE WHEN payload IS NULL THEN 1 ELSE 0 END) AS processed, SUM(CASE WHEN payload IS NOT NULL THEN 1 ELSE 0 END) AS pending FROM wa_inbox',
        )
        .one();
      const outbound = this.ctx.storage.sql
        .exec(
          'SELECT state,attempts,delivery_status,last_error FROM wa_outbox ORDER BY rowid',
        )
        .toArray();
      return {
        ...records,
        patients: records.patients.map((p) => ({
          ...p,
          whatsappNumber: mask(p.whatsappNumber),
        })),
        appointments: records.appointments.map((a) => ({
          ...a,
          whatsappNumber: mask(a.whatsappNumber),
        })),
        conversations,
        inbox,
        outbound,
        projection: repo.projectionStatus(),
      };
    });
  }
  async developmentReplay(): Promise<Batch | null> {
    return this.developmentRepository().coordinate(async () => {
      const replay = await this.ctx.storage.get<Replay>(replayKey);
      await this.ctx.storage.delete(replayKey);
      return replay && replay.expiresAt > Date.now() ? replay.batch : null;
    });
  }
  override async alarm() {
    await this.developmentRepository().coordinate(async () => {
      const replay = await this.ctx.storage.get<Replay>(replayKey);
      if (replay && replay.expiresAt <= Date.now())
        await this.ctx.storage.delete(replayKey);
    });
    await super.alarm();
  }
}
async function authorized(
  request: Request,
  secret: string | undefined,
): Promise<boolean> {
  if (!secret || secret.length < 32) return false;
  const digest = async (value: string) =>
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
    );
  const [expected, actual] = await Promise.all([
    digest(`Bearer ${secret}`),
    digest(request.headers.get('authorization') ?? ''),
  ]);
  let different = 0;
  for (let i = 0; i < expected.length; i++)
    different |= expected[i]! ^ actual[i]!;
  return different === 0;
}
async function replayRequest(
  batch: Batch,
  url: string,
  secret: string,
): Promise<Request> {
  const messages = batch.messages.map((m) => ({
    id: m.id,
    from: m.sender,
    timestamp: String(Math.floor(m.timestamp / 1000)),
    ...(m.input.type === 'action'
      ? {
          type: 'interactive',
          interactive: {
            type: 'button_reply',
            button_reply: { id: m.input.value },
          },
        }
      : m.input.type === 'text'
        ? { type: 'text', text: { body: m.input.value } }
        : { type: 'unknown' }),
  }));
  const body = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: batch.phoneNumberId },
              messages,
            },
          },
        ],
      },
    ],
  });
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = Array.from(
    new Uint8Array(
      await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)),
    ),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
  return new Request(new URL('/webhooks/whatsapp', url), {
    method: 'POST',
    body,
    headers: { 'x-hub-signature-256': `sha256=${signature}` },
  });
}
export default {
  async fetch(request: Request, env: DevelopmentEnv): Promise<Response> {
    if (env.DEVELOPMENT_MODE !== 'true')
      return new Response('Not found', { status: 404 });
    const path = new URL(request.url).pathname;
    if (!path.startsWith('/__development/'))
      return production.fetch(request, env);
    if (!(await authorized(request, env.DEVELOPMENT_ADMIN_TOKEN)))
      return new Response('Forbidden', { status: 403 });
    const stub = env.CLINICS.getByName(
      TEST_CLINIC,
    ) as DurableObjectStub<ClinicDurableObject>;
    try {
      if (path === '/__development/inspect' && request.method === 'GET')
        return Response.json(await stub.inspectDevelopment(), {
          headers: { 'cache-control': 'no-store' },
        });
      if (request.method !== 'POST')
        return new Response('Method not allowed', { status: 405 });
      if (path === '/__development/replay') {
        if (!env.META_APP_SECRET)
          return new Response('Unavailable', { status: 503 });
        const batch = await stub.developmentReplay();
        if (!batch)
          return new Response('No recent test message', { status: 409 });
        const result = await production.fetch(
          await replayRequest(batch, request.url, env.META_APP_SECRET),
          env,
        );
        await stub.developmentReplay();
        return new Response(null, { status: result.status });
      }
      if (path === '/__development/projection/bootstrap')
        return Response.json(await stub.bootstrapProjection(TEST_CLINIC));
      if (path === '/__development/projection/drain')
        return Response.json(await stub.drainProjection(TEST_CLINIC));
      if (path === '/__development/configure') {
        const config = (await request.json()) as ClinicConfiguration;
        if (
          config.clinic.clinicId !== TEST_CLINIC ||
          config.clinic.doctorName !== 'Demo Doctor' ||
          config.clinic.specialty !== 'Specialist'
        )
          return new Response('Synthetic clinic only', { status: 400 });
        return Response.json(await stub.configure(config, 'development-test'));
      }
      if (path === '/__development/compete') {
        const input = (await request.json()) as { date: string; time: string };
        return Response.json(
          await stub.book({
            clinicId: TEST_CLINIC,
            patientId: 'synthetic-competitor',
            patientName: 'Synthetic Competitor',
            whatsappNumber: '+12025550199',
            appointmentDate: input.date,
            startTime: input.time,
            source: 'Phone',
            createdBy: 'development-test',
          }),
        );
      }
      return new Response('Not found', { status: 404 });
    } catch {
      return new Response('Development operation failed', { status: 503 });
    }
  },
} satisfies ExportedHandler<DevelopmentEnv>;
