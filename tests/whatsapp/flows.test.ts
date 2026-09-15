import { env } from 'cloudflare:workers';
import {
  runInDurableObject,
  reset,
  evictDurableObject,
  runDurableObjectAlarm,
} from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkerEnv } from '../../src/adapters/cloudflare/worker.js';
import worker from '../../src/adapters/cloudflare/worker.js';
import { SqliteClinicRepository } from '../../src/adapters/cloudflare/repository.js';
import { WhatsAppStore } from '../../src/adapters/whatsapp/store.js';
import { MetaClient } from '../../src/adapters/whatsapp/client.js';
import type { Incoming, Input } from '../../src/adapters/whatsapp/models.js';
import type { Conversation } from '../../src/adapters/whatsapp/conversation.js';
import { AppointmentService } from '../../src/appointments/service.js';
import { clinic, hours } from '../support/fixtures.js';

const bindings = env as WorkerEnv;
const stub = () => bindings.CLINICS.getByName(clinic.clinicId);
const initial = Date.parse('2030-09-16T03:00:00Z');
const sender = '12025550123';
const other = '12025550124';
const phone = '100000000001';
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await reset();
});

type Wire = {
  to: string;
  text?: { body: string };
  interactive?: {
    body: { text: string };
    action: {
      buttons?: { reply: { id: string; title: string } }[];
      sections?: { rows: { id: string; title: string }[] }[];
    };
  };
};
async function setup(
  run: (h: Awaited<ReturnType<typeof harness>>) => Promise<void>,
) {
  await runInDurableObject(stub(), async (_instance, state) =>
    run(await harness(state.storage)),
  );
}
async function harness(storage: DurableObjectStorage) {
  let now = initial;
  let sequence = 0;
  const clock = {
    now: () => new Date(now),
    advance: (ms: number) => {
      now += ms;
    },
  };
  let repo = new SqliteClinicRepository(storage, clinic.clinicId, clock);
  await repo.configure(
    { clinic, workingHours: [hours], blockedSlots: [] },
    'synthetic-clerk',
  );
  let store = new WhatsAppStore(storage, repo, clock);
  const sent: Wire[] = [];
  const http = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    sent.push(JSON.parse(init!.body as string) as Wire);
    return Response.json({ messages: [{ id: `wamid.out.${sent.length}` }] });
  });
  const client = new MetaClient({ META_ACCESS_TOKEN: 'synthetic' }, http);
  const service = new AppointmentService(repo, clock, {
    next: () => crypto.randomUUID(),
  });
  const last = () => sent.at(-1)!;
  const body = () => last().text?.body ?? last().interactive!.body.text;
  const choices = () =>
    last().interactive?.action.buttons?.map((b) => b.reply) ??
    last().interactive?.action.sections?.flatMap((s) => s.rows) ??
    [];
  const state = (who = sender) => {
    const row = storage.sql
      .exec<{ record: string }>(
        'SELECT record FROM wa_conversations WHERE sender=?',
        who,
      )
      .toArray()[0];
    return row ? (JSON.parse(row.record) as Conversation) : null;
  };
  const enqueue = async (
    input: Input,
    who = sender,
    id = `wamid.in.${++sequence}`,
  ) => {
    const incoming: Incoming = { id, sender: who, timestamp: now, input };
    await store.enqueue({
      phoneNumberId: phone,
      messages: [incoming],
      statuses: [],
    });
    return incoming;
  };
  const receive = async (input: Input, who = sender) => {
    const message = await enqueue(input, who);
    await store.drain(client);
    return message;
  };
  const text = (value: string, who = sender) =>
    receive({ type: 'text', value }, who);
  const click = (action: string, who = sender) => {
    const choice = choices().find((c) => c.id.endsWith(`:${action}`));
    expect(choice, `Expected action ${action}; body: ${body()}`).toBeDefined();
    return receive({ type: 'action', value: choice!.id }, who);
  };
  const bookToConfirm = async (who = sender, time = '09:00') => {
    await text('hi', who);
    await click('book', who);
    await click('date:2030-09-16', who);
    await click(`slot:${time}`, who);
    if (state(who)!.step === 'name') await text('Synthetic Patient', who);
    await click('skip', who);
  };
  const manage = async (id: string) => {
    await text('menu');
    await click('manage');
    await click(`appointment:${id}`);
  };
  const book = () =>
    service.book({
      clinicId: clinic.clinicId,
      patientId: 'synthetic-patient',
      patientName: 'Reusable Name',
      whatsappNumber: `+${sender}`,
      appointmentDate: '2030-09-16',
      startTime: '09:00',
      source: 'WhatsApp',
      createdBy: 'synthetic',
    });
  return {
    storage,
    get repo() {
      return repo;
    },
    get store() {
      return store;
    },
    clock,
    http,
    client,
    service,
    sent,
    last,
    body,
    choices,
    state,
    enqueue,
    receive,
    text,
    click,
    bookToConfirm,
    manage,
    book,
    restart: () => {
      repo = new SqliteClinicRepository(storage, clinic.clinicId, clock);
      store = new WhatsAppStore(storage, repo, clock);
    },
  };
}

describe('durable patient conversations', () => {
  it('greets, lists real dates/slots, collects name, skips reason and atomically books once', async () =>
    setup(async (h) => {
      await h.bookToConfirm();
      expect(h.body()).toContain(clinic.doctorName);
      expect(h.body()).toContain('Synthetic Patient');
      expect(h.repo.exportRecords().appointments).toHaveLength(0);
      const confirmation = await h.click('confirm');
      expect(h.body()).toContain('Appointment confirmed.');
      const appointments = h.repo.exportRecords().appointments;
      expect(appointments).toHaveLength(1);
      expect(appointments[0]).not.toHaveProperty('reason');
      const version = h.state()!.version;
      const sends = h.sent.length;
      h.restart();
      await h.store.enqueue({
        phoneNumberId: phone,
        messages: [confirmation],
        statuses: [],
      });
      await h.store.drain(h.client);
      expect(h.repo.exportRecords().appointments).toHaveLength(1);
      expect(h.state()!.version).toBe(version);
      expect(h.sent).toHaveLength(sends);
      expect(
        h.storage.sql
          .exec('SELECT payload FROM wa_inbox WHERE payload IS NOT NULL')
          .toArray(),
      ).toEqual([]);
      expect(
        h.storage.sql
          .exec('SELECT payload FROM wa_outbox WHERE payload IS NOT NULL')
          .toArray(),
      ).toEqual([]);
    }));
  it('reuses and corrects an existing name, stores an optional administrative note', async () =>
    setup(async (h) => {
      await h.book();
      await h.bookToConfirm(sender, '09:20');
      expect(h.state()!.name).toBe('Reusable Name');
      await h.click('change');
      await h.click('change-name');
      await h.text('Corrected Example');
      await h.text('First appointment');
      expect(h.body()).toContain('First appointment');
      await h.click('confirm');
      expect(
        h.repo
          .exportRecords()
          .appointments.find((a) => a.startTime === '09:20'),
      ).toMatchObject({
        patientName: 'Corrected Example',
        reason: 'First appointment',
        patientId: 'synthetic-patient',
      });
      expect(h.repo.exportRecords().patients).toHaveLength(1);
    }));
  it('rejects stale interactive confirmations even under a different incoming ID', async () =>
    setup(async (h) => {
      await h.bookToConfirm();
      const confirm = h.choices()[0]!.id;
      await h.click('confirm');
      await h.receive({ type: 'action', value: confirm });
      expect(h.repo.exportRecords().appointments).toHaveLength(1);
      expect(h.body()).toContain('current options');
    }));
  it('refreshes alternatives when another patient takes the displayed slot', async () =>
    setup(async (h) => {
      await h.bookToConfirm();
      await h.service.book({
        clinicId: clinic.clinicId,
        patientId: 'other',
        patientName: 'Other Example',
        whatsappNumber: `+${other}`,
        appointmentDate: '2030-09-16',
        startTime: '09:00',
        source: 'WhatsApp',
        createdBy: 'synthetic',
      });
      await h.click('confirm');
      expect(h.body()).toContain('no longer available');
      expect(h.choices().some((c) => c.title === '09:00')).toBe(false);
      expect(h.repo.exportRecords().appointments).toHaveLength(1);
      await h.click('slot:09:20');
      await h.click('skip');
      await h.click('confirm');
      expect(h.repo.exportRecords().appointments).toHaveLength(2);
    }));
  it('does not turn a committed booking into failure when Sheets is unavailable', async () =>
    setup(async (h) => {
      await h.bookToConfirm();
      await h.click('confirm');
      await h.repo.flushProjection({
        applySnapshot: async () => {
          throw new Error('synthetic outage');
        },
      });
      expect(h.repo.projectionStatus().pending).toBe(2);
      expect(h.body()).toContain('Appointment confirmed.');
      expect(h.repo.exportRecords().appointments).toHaveLength(1);
      expect(await h.storage.getAlarm()).not.toBeNull();
    }));
  it('limits appointment lookup to the current WhatsApp identity', async () =>
    setup(async (h) => {
      const a = await h.book();
      await h.text('hi', other);
      await h.click('lookup', other);
      expect(h.body()).toContain('no eligible');
      expect(h.body()).not.toContain(a.appointmentId);
      await h.text('menu');
      await h.click('lookup');
      await h.click(`appointment:${a.appointmentId}`);
      expect(h.body()).toContain(a.appointmentId);
      await h.text('menu', other);
      await h.receive(
        {
          type: 'action',
          value: `${h.state(other)!.token}:appointment:${a.appointmentId}`,
        },
        other,
      );
      expect(h.body()).not.toContain(a.appointmentId);
    }));
  it('requires cancellation confirmation and supports keeping the appointment', async () =>
    setup(async (h) => {
      const a = await h.book();
      await h.manage(a.appointmentId);
      await h.click('cancel');
      expect(h.repo.exportRecords().appointments[0]!.status).toBe('Scheduled');
      await h.click('abort');
      expect(h.repo.exportRecords().appointments[0]!.status).toBe('Scheduled');
      await h.manage(a.appointmentId);
      await h.click('cancel');
      await h.click('confirm-cancel');
      expect(h.repo.exportRecords().appointments[0]!.status).toBe('Cancelled');
      expect(h.body()).toContain('cancelled');
    }));
  it('atomically reschedules, preserves original history and handles duplicate confirmation', async () =>
    setup(async (h) => {
      const a = await h.book();
      await h.manage(a.appointmentId);
      await h.click('reschedule');
      await h.click('date:2030-09-16');
      await h.click('slot:09:20');
      expect(h.body()).toContain('Confirm reschedule');
      const confirmed = await h.click('confirm');
      const records = h.repo.exportRecords().appointments;
      expect(
        records.find((r) => r.appointmentId === a.appointmentId),
      ).toMatchObject({ status: 'Rescheduled', startTime: '09:00' });
      expect(records.find((r) => r.status === 'Scheduled')).toMatchObject({
        rescheduledFrom: a.appointmentId,
        startTime: '09:20',
      });
      await h.store.enqueue({
        phoneNumberId: phone,
        messages: [confirmed],
        statuses: [],
      });
      await h.store.drain(h.client);
      expect(h.repo.exportRecords().appointments).toHaveLength(2);
    }));
  it('preserves the original when a replacement slot is taken before confirmation', async () =>
    setup(async (h) => {
      const a = await h.book();
      await h.manage(a.appointmentId);
      await h.click('reschedule');
      await h.click('date:2030-09-16');
      await h.click('slot:09:20');
      await h.service.book({
        clinicId: clinic.clinicId,
        patientId: 'other',
        patientName: 'Other Example',
        whatsappNumber: `+${other}`,
        appointmentDate: '2030-09-16',
        startTime: '09:20',
        source: 'WhatsApp',
        createdBy: 'synthetic',
      });
      await h.click('confirm');
      expect(h.body()).toContain('no longer available');
      expect(
        await h.repo.findById(clinic.clinicId, a.appointmentId),
      ).toMatchObject({ status: 'Scheduled', rescheduledTo: null });
    }));
  it.each(['inactive', 'suspended'] as const)(
    'blocks new usage but allows existing lookup/cancel for %s',
    async (status) =>
      setup(async (h) => {
        const a = await h.book();
        await h.repo.configure(
          {
            clinic: { ...clinic, subscriptionStatus: status },
            workingHours: [hours],
            blockedSlots: [],
          },
          'synthetic',
        );
        await h.text('hi');
        await h.click('book');
        expect(h.body()).toContain('currently unavailable');
        await h.manage(a.appointmentId);
        await h.click('reschedule');
        expect(h.body()).toContain('currently unavailable');
        await h.manage(a.appointmentId);
        await h.click('cancel');
        await h.click('confirm-cancel');
        expect(h.repo.exportRecords().appointments[0]!.status).toBe(
          'Cancelled',
        );
      }),
  );
  it('handles unknown text/media, name limits, menu/restart and session expiry', async () =>
    setup(async (h) => {
      await h.text('unexpected beginning');
      expect(h.choices()).toHaveLength(3);
      await h.receive({ type: 'unsupported', value: '' });
      expect(h.body()).toContain('current options');
      await h.click('book');
      await h.click('date:2030-09-16');
      await h.click('slot:09:00');
      await h.text('x'.repeat(81));
      expect(h.state()!.step).toBe('name');
      await h.text('restart');
      expect(h.state()!.step).toBe('menu');
      await h.click('book');
      const stale = h.choices()[0]!.id;
      h.clock.advance(31 * 60_000);
      await h.receive({ type: 'action', value: stale });
      expect(h.body()).toContain('expired');
      expect(h.state()!.step).toBe('menu');
    }));
  it('does not list closed or fully blocked dates and recovers if availability disappears', async () =>
    setup(async (h) => {
      await h.repo.configure(
        {
          clinic: { ...clinic, bookingHorizonDays: 1 },
          workingHours: [],
          blockedSlots: [],
        },
        'synthetic',
      );
      await h.text('hi');
      await h.click('book');
      expect(h.body()).toContain('No appointments');
      await h.repo.configure(
        {
          clinic: { ...clinic, bookingHorizonDays: 1 },
          workingHours: [hours],
          blockedSlots: [],
        },
        'synthetic',
      );
      await h.click('book');
      expect(h.choices()).toHaveLength(1);
      await h.repo.configure(
        {
          clinic: { ...clinic, bookingHorizonDays: 1 },
          workingHours: [],
          blockedSlots: [],
        },
        'synthetic',
      );
      await h.click('date:2030-09-16');
      expect(h.body()).toContain('No appointments');
    }));
  it('pages more than nine times and permits changing the date before confirmation', async () =>
    setup(async (h) => {
      await h.repo.configure(
        {
          clinic,
          workingHours: [{ ...hours, endTime: '14:00' }],
          blockedSlots: [],
        },
        'synthetic',
      );
      await h.text('hi');
      await h.click('book');
      await h.click('date:2030-09-16');
      expect(h.choices()).toHaveLength(10);
      await h.click('more');
      expect(h.choices()[0]!.title).toBe('12:00');
      await h.click('slot:12:00');
      await h.text('Synthetic');
      await h.click('skip');
      await h.click('change');
      await h.click('change-date');
      expect(h.state()!.step).toBe('date');
      await h.text('menu');
      expect(h.state()!.step).toBe('menu');
    }));
  it('rolls back appointment, patient, audit, state, receipt and outbound together on commit failure', async () =>
    setup(async (h) => {
      await h.bookToConfirm();
      const version = h.state()!.version;
      const input = await h.enqueue({
        type: 'action',
        value: h.choices()[0]!.id,
      });
      h.storage.sql.exec(
        "CREATE TRIGGER reject_outbound BEFORE INSERT ON wa_outbox BEGIN SELECT RAISE(ABORT,'synthetic failure'); END",
      );
      await h.store.drain(h.client);
      expect(h.repo.exportRecords().appointments).toHaveLength(0);
      expect(h.repo.exportRecords().patients).toHaveLength(0);
      expect(h.repo.exportRecords().activity).toHaveLength(1);
      expect(h.state()!.version).toBe(version);
      expect(
        h.storage.sql
          .exec('SELECT payload FROM wa_inbox WHERE id=?', input.id)
          .one().payload,
      ).not.toBeNull();
      h.storage.sql.exec('DROP TRIGGER reject_outbound');
      h.clock.advance(30_000);
      h.restart();
      await h.store.drain(h.client);
      expect(h.repo.exportRecords().appointments).toHaveLength(1);
      expect(h.body()).toContain('confirmed');
    }));
  it('does not let a stale cancelled appointment be rescheduled or cancelled twice', async () =>
    setup(async (h) => {
      const a = await h.book();
      await h.manage(a.appointmentId);
      await h.click('cancel');
      await h.service.transition({
        clinicId: clinic.clinicId,
        appointmentId: a.appointmentId,
        to: 'Cancelled',
        actor: { id: 'synthetic', role: 'Clerk' },
      });
      await h.click('confirm-cancel');
      expect(h.body()).toContain('no longer available');
      expect(h.repo.exportRecords().appointments).toHaveLength(1);
    }));
});

describe('durable WhatsApp delivery', () => {
  it('persists status events separately, handles early/out-of-order statuses and recipient isolation', async () =>
    setup(async (h) => {
      const statuses = async (
        status: 'sent' | 'delivered' | 'read' | 'failed',
        recipient = sender,
      ) =>
        h.store.enqueue({
          phoneNumberId: phone,
          messages: [],
          statuses: [
            {
              id: 'wamid.out.1',
              recipient,
              status,
              timestamp: h.clock.now().getTime(),
            },
          ],
        });
      await statuses('read');
      await h.text('hi');
      const state = h.state();
      expect(
        h.storage.sql.exec('SELECT delivery_status FROM wa_outbox').one()
          .delivery_status,
      ).toBe('read');
      await statuses('sent');
      await statuses('failed');
      await statuses('delivered', other);
      expect(h.state()).toEqual(state);
      expect(
        h.storage.sql.exec('SELECT delivery_status FROM wa_outbox').one()
          .delivery_status,
      ).toBe('read');
    }));
  it('bounds 429 retries, persists deadlines and prevents duplicate sends across reinstantiation', async () =>
    setup(async (h) => {
      h.http.mockImplementation(
        async () =>
          new Response('', { status: 429, headers: { 'retry-after': '2' } }),
      );
      await h.text('hi');
      expect(h.http).toHaveBeenCalledTimes(1);
      h.restart();
      await h.store.drain(h.client);
      expect(h.http).toHaveBeenCalledTimes(1);
      h.clock.advance(2000);
      await h.store.drain(h.client);
      expect(h.http).toHaveBeenCalledTimes(2);
      h.clock.advance(2000);
      await h.store.drain(h.client);
      expect(h.http).toHaveBeenCalledTimes(3);
      h.clock.advance(5000);
      await h.store.drain(h.client);
      expect(h.http).toHaveBeenCalledTimes(3);
      expect(
        h.storage.sql.exec('SELECT state,payload FROM wa_outbox').one(),
      ).toMatchObject({ state: 'failed', payload: null });
    }));
  it('never automatically replays uncertain network sends or interrupted attempts', async () =>
    setup(async (h) => {
      h.http.mockRejectedValue(new Error('private'));
      await h.text('hi');
      h.restart();
      h.clock.advance(60000);
      await h.store.drain(h.client);
      expect(h.http).toHaveBeenCalledTimes(1);
      h.storage.sql.exec("UPDATE wa_outbox SET state='attempting'");
      await h.store.drain(h.client);
      expect(h.http).toHaveBeenCalledTimes(1);
      expect(
        h.storage.sql.exec('SELECT state FROM wa_outbox').one().state,
      ).toBe('unknown');
    }));
  it('expires delayed inbound/freeform outbound and cleans transient conversation data', async () =>
    setup(async (h) => {
      const message = await h.enqueue({ type: 'text', value: 'hi' });
      h.clock.advance(86400001);
      await h.store.drain(h.client);
      expect(h.sent).toHaveLength(0);
      await h.store.enqueue({
        phoneNumberId: phone,
        messages: [{ ...message, id: 'wamid.old' }],
        statuses: [],
      });
      await h.store.drain(h.client);
      expect(h.sent).toHaveLength(0);
      h.http.mockImplementation(
        async () =>
          new Response('', { status: 429, headers: { 'retry-after': '3600' } }),
      );
      await h.text('hi');
      expect(h.http).toHaveBeenCalledTimes(1);
      h.clock.advance(86400001);
      await h.store.drain(h.client);
      expect(h.http).toHaveBeenCalledTimes(1);
      expect(h.state()).toBeNull();
      h.clock.advance(7 * 86400000);
      await h.store.drain(h.client);
      expect(
        h.storage.sql.exec('SELECT * FROM wa_outbox').toArray(),
      ).toHaveLength(0);
    }));
  it('keeps WhatsApp alarms scheduled when the Sheets queue drains', async () =>
    setup(async (h) => {
      await h.enqueue({ type: 'text', value: 'hi' });
      await h.repo.flushProjection({ applySnapshot: async () => {} });
      expect(await h.storage.getAlarm()).toBe(h.clock.now().getTime() + 1000);
      await h.store.drain(h.client);
      expect(await h.storage.getAlarm()).toBe(h.state()!.expiresAt);
    }));
  it('serializes concurrent drains without duplicate state or outbound effects', async () =>
    setup(async (h) => {
      await h.enqueue({ type: 'text', value: 'hi' });
      await Promise.all([
        h.store.drain(h.client),
        new WhatsAppStore(
          h.storage,
          new SqliteClinicRepository(h.storage, clinic.clinicId, h.clock),
          h.clock,
        ).drain(h.client),
      ]);
      expect(h.sent).toHaveLength(1);
      expect(h.state()!.version).toBe(1);
    }));
  it('survives a real Durable Object eviction with pending inbound work', async () => {
    await runInDurableObject(stub(), async (_instance, state) => {
      const h = await harness(state.storage);
      await h.enqueue({ type: 'text', value: 'hello' });
    });
    await evictDurableObject(stub());
    await runInDurableObject(stub(), async (_instance, state) => {
      const clock = { now: () => new Date(initial) };
      const repo = new SqliteClinicRepository(
        state.storage,
        clinic.clinicId,
        clock,
      );
      const http = vi
        .fn<typeof fetch>()
        .mockImplementation(async () =>
          Response.json({ messages: [{ id: 'wamid.out.restart' }] }),
        );
      await new WhatsAppStore(state.storage, repo, clock).drain(
        new MetaClient({ META_ACCESS_TOKEN: 'synthetic' }, http),
      );
      expect(http).toHaveBeenCalledTimes(1);
      expect(
        state.storage.sql.exec('SELECT * FROM wa_conversations').toArray(),
      ).toHaveLength(1);
    });
  });
  it('exposes only the webhook route and routes internally to the named clinic', async () => {
    expect(
      (await worker.fetch(new Request('https://example.test/other'), bindings))
        .status,
    ).toBe(404);
    const result = await stub().receiveWhatsApp('wrong-clinic', {
      phoneNumberId: phone,
      messages: [],
      statuses: [],
    });
    expect(result.ok).toBe(false);
    // Empty authenticated handoff also exercises production alarm composition without live credentials.
    expect(
      (
        await stub().receiveWhatsApp(clinic.clinicId, {
          phoneNumberId: phone,
          messages: [],
          statuses: [],
        })
      ).ok,
    ).toBe(true);
    await runDurableObjectAlarm(stub());
  });
});

describe('patient policy edge cases', () => {
  it('revalidates subscription after displaying a booking confirmation', async () =>
    setup(async (h) => {
      await h.bookToConfirm();
      await h.repo.configure(
        {
          clinic: { ...clinic, subscriptionStatus: 'suspended' },
          workingHours: [hours],
          blockedSlots: [],
        },
        'synthetic',
      );
      await h.click('confirm');
      expect(h.repo.exportRecords().appointments).toHaveLength(0);
      expect(h.body()).toContain('currently unavailable');
    }));
  it('offers clinic-local tomorrow when same-day booking is disabled', async () =>
    setup(async (h) => {
      await h.repo.configure(
        {
          clinic: { ...clinic, sameDayBookingAllowed: false },
          workingHours: [hours, { ...hours, dayOfWeek: 2 }],
          blockedSlots: [],
        },
        'synthetic',
      );
      await h.text('hi');
      await h.click('book');
      expect(h.choices()[0]!.title).toBe('2030-09-17');
    }));
  it('pages owned appointments and excludes terminal and past records from management', async () =>
    setup(async (h) => {
      await h.repo.configure(
        {
          clinic,
          workingHours: [{ ...hours, endTime: '14:00' }],
          blockedSlots: [],
        },
        'synthetic',
      );
      for (let i = 0; i < 11; i++) {
        const minutes = 9 * 60 + 20 * i;
        const time = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
        await h.service.book({
          clinicId: clinic.clinicId,
          patientId: 'synthetic',
          patientName: 'Synthetic',
          whatsappNumber: `+${sender}`,
          appointmentDate: '2030-09-16',
          startTime: time,
          source: 'WhatsApp',
          createdBy: 'synthetic',
        });
      }
      await h.text('menu');
      await h.click('manage');
      expect(h.choices()).toHaveLength(10);
      await h.click('more');
      expect(h.choices()).toHaveLength(2);
      h.clock.advance(6 * 60 * 60_000);
      await h.text('menu');
      await h.click('manage');
      expect(h.body()).toContain('no eligible');
    }));
  it('recovers stale availability after the selected date leaves the booking horizon', async () =>
    setup(async (h) => {
      await h.bookToConfirm();
      h.clock.advance(60 * 1000);
      await h.repo.configure(
        {
          clinic: { ...clinic, sameDayBookingAllowed: false },
          workingHours: [hours],
          blockedSlots: [],
        },
        'synthetic',
      );
      await h.click('confirm');
      expect(h.repo.exportRecords().appointments).toHaveLength(0);
      expect(h.body()).toContain('no longer available');
    }));
  it('keeps another recipient moving during rate limiting and retries only the rejected recipient', async () =>
    setup(async (h) => {
      h.http.mockImplementation(async (_url, init) => {
        const request = JSON.parse(init!.body as string) as Wire;
        if (request.to === sender)
          return new Response('', {
            status: 429,
            headers: { 'retry-after': '10' },
          });
        h.sent.push(request);
        return Response.json({ messages: [{ id: 'wamid.other' }] });
      });
      await h.text('hi');
      await h.text('hello', other);
      expect(h.sent).toHaveLength(1);
      expect(h.sent[0]!.to).toBe(other);
      expect(h.http).toHaveBeenCalledTimes(2);
    }));
  it('applies sent/delivered/failed statuses without regressing delivery or altering the session', async () =>
    setup(async (h) => {
      await h.text('hi');
      const before = h.state();
      for (const status of [
        'sent',
        'failed',
        'sent',
        'delivered',
        'sent',
        'read',
      ] as const) {
        await h.store.enqueue({
          phoneNumberId: phone,
          messages: [],
          statuses: [
            {
              id: 'wamid.out.1',
              recipient: sender,
              status,
              timestamp: h.clock.now().getTime(),
            },
          ],
        });
        if (status === 'failed')
          expect(
            h.storage.sql.exec('SELECT delivery_status FROM wa_outbox').one()
              .delivery_status,
          ).toBe('failed');
      }
      expect(
        h.storage.sql.exec('SELECT delivery_status FROM wa_outbox').one()
          .delivery_status,
      ).toBe('read');
      expect(h.state()).toEqual(before);
    }));
});

it('bounds date scans and pages a long, empty configured horizon without blocking the clinic', async () =>
  setup(async (h) => {
    await h.repo.configure(
      {
        clinic: { ...clinic, bookingHorizonDays: 60 },
        workingHours: [],
        blockedSlots: [],
      },
      'synthetic',
    );
    await h.text('hi');
    await h.click('book');
    expect(h.choices()).toHaveLength(1);
    expect(h.choices()[0]!.title).toBe('More dates');
    expect(h.state()!.offset).toBe(30);
    await h.click('more-dates');
    expect(h.body()).toContain('No appointments');
  }));

it('hands a signed public callback to clinic persistence and rejects a failed handoff', async () => {
  const value = {
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: phone },
              messages: [],
              statuses: [],
            },
          },
        ],
      },
    ],
  };
  const raw = JSON.stringify(value);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode('synthetic-secret'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature =
    'sha256=' +
    Array.from(
      new Uint8Array(
        await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw)),
      ),
      (b) => b.toString(16).padStart(2, '0'),
    ).join('');
  const request = () =>
    new Request('https://example.test/webhooks/whatsapp', {
      method: 'POST',
      body: raw,
      headers: { 'x-hub-signature-256': signature },
    });
  const config = {
    ...bindings,
    META_APP_SECRET: 'synthetic-secret',
    WHATSAPP_PHONE_CLINICS: JSON.stringify({ [phone]: clinic.clinicId }),
  };
  expect((await worker.fetch(request(), config)).status).toBe(200);
  await runInDurableObject(stub(), async (_instance, state) => {
    expect(
      state.storage.sql.exec('SELECT clinic_id FROM metadata').one().clinic_id,
    ).toBe(clinic.clinicId);
  });
  const broken = {
    ...config,
    CLINICS: {
      idFromName: () => 'synthetic',
      get: () => ({ receiveWhatsApp: async () => ({ ok: false }) }),
    },
  } as unknown as WorkerEnv;
  expect((await worker.fetch(request(), broken)).status).toBe(503);
});
