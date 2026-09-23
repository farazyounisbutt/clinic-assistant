import { env } from 'cloudflare:workers';
import { reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import type { WorkerEnv } from '../../src/adapters/cloudflare/worker.js';
import { SqliteClinicRepository } from '../../src/adapters/cloudflare/repository.js';
import { WhatsAppStore } from '../../src/adapters/whatsapp/store.js';
import { MetaClient } from '../../src/adapters/whatsapp/client.js';
import { configuredOperators } from '../../src/adapters/whatsapp/operators.js';
import { converseDoctor } from '../../src/adapters/whatsapp/doctor.js';
import { MetaFailure } from '../../src/adapters/whatsapp/models.js';
import type { Message, Input } from '../../src/adapters/whatsapp/models.js';
import type { Appointment } from '../../src/appointments/models.js';
import { appointment, clinic, hours } from '../support/fixtures.js';

const doctor = '12025550180';
const patient = '12025550123';
const clerk = '12025550190';
const mapping = [
  {
    clinicId: clinic.clinicId,
    sender: doctor,
    operatorId: 'test-doctor',
    role: 'Doctor',
  },
  {
    clinicId: clinic.clinicId,
    sender: clerk,
    operatorId: 'test-clerk',
    role: 'Clerk',
  },
];
afterEach(reset);
async function setup(
  run: (h: Awaited<ReturnType<typeof harness>>) => Promise<void>,
) {
  await runInDurableObject(
    (env as WorkerEnv).CLINICS.getByName(clinic.clinicId),
    async (_, state) => run(await harness(state.storage)),
  );
}
async function harness(storage: DurableObjectStorage) {
  let now = Date.parse('2030-09-15T23:00:00Z'); // Monday in Karachi, Sunday in UTC.
  const clock = { now: () => new Date(now) };
  const repo = new SqliteClinicRepository(storage, clinic.clinicId, clock);
  await repo.configure(
    { clinic, workingHours: [hours], blockedSlots: [] },
    'test',
  );
  let store = new WhatsAppStore(
    storage,
    repo,
    clock,
    configuredOperators(JSON.stringify(mapping)),
  );
  const sent: Message[] = [];
  const messenger = {
    send: async (p: string, r: string, m: Message) => {
      await new MetaClient({ META_ACCESS_TOKEN: 'synthetic' }, async () =>
        Response.json({ messages: [{ id: 'wamid.test' }] }),
      ).send(p, r, m);
      sent.push(m);
      return `wamid.out.${sent.length}`;
    },
  };
  let seq = 0;
  const receive = async (input: Input, who = doctor) => {
    await store.enqueue({
      phoneNumberId: '100000000001',
      messages: [
        { id: `wamid.in.${++seq}`, sender: who, timestamp: now, input },
      ],
      statuses: [],
    });
    await store.drain(messenger);
  };
  const last = () => sent.at(-1)!;
  const choices = () => {
    const m = last();
    return m.type === 'text' ? [] : m.choices;
  };
  const text = (value: string, who = doctor) =>
    receive({ type: 'text', value }, who);
  const click = (id: string, who = doctor) => {
    const choice = choices().find((c) => c.id.endsWith(`:${id}`));
    expect(choice).toBeDefined();
    return receive({ type: 'action', value: choice!.id }, who);
  };
  return {
    repo,
    storage,
    clock,
    sent,
    messenger,
    last,
    choices,
    receive,
    text,
    click,
    get store() {
      return store;
    },
    advance: (ms: number) => {
      now += ms;
    },
    auth: (raw: string) => {
      store = new WhatsAppStore(storage, repo, clock, configuredOperators(raw));
    },
    seed: (a: Partial<Appointment>) =>
      repo.runExclusive(clinic.clinicId, (u) =>
        u.insert(appointment({ appointmentDate: '2030-09-16', ...a })),
      ),
  };
}

it('requires explicit clinic-scoped Doctor authorization and never grants Clerk privileges', async () =>
  setup(async (h) => {
    await h.text('doctor', patient);
    expect(h.choices().map((c) => c.title)).toContain('Book Appointment');
    await h.text('doctor');
    expect(h.choices().map((c) => c.title)).toEqual([
      "Today's Appointments",
      'Waiting Queue',
      'Daily Summary',
    ]);
    const action = h.choices()[1]!.id;
    await h.receive({ type: 'action', value: action }, patient);
    expect(h.last().body).not.toContain('Waiting queue');
    await h.text('clerk');
    expect(h.choices().some((c) => c.title === 'Add Walk-in')).toBe(false);
    await h.text('menu', clerk);
    expect(h.choices().map((c) => c.title)).toContain('Add Walk-in');
    expect(h.choices().map((c) => c.title)).not.toContain('Daily Summary');
    h.auth(JSON.stringify([{ ...mapping[0], clinicId: 'other_clinic' }]));
    await h.text('doctor');
    expect(h.choices().map((c) => c.title)).toContain('Book Appointment');
  }));

it('shows clinic-local AM/PM appointments and operational summary without domain or projection mutations', async () =>
  setup(async (h) => {
    const statuses = [
      'Scheduled',
      'CheckedIn',
      'Completed',
      'NoShow',
      'Cancelled',
      'Rescheduled',
    ] as const;
    const detailId = '00000000-0000-4000-8000-000000000003';
    for (let i = 0; i < statuses.length; i++)
      await h.seed({
        appointmentId: i === 3 ? detailId : `a-${i}`,
        patientName: `Synthetic ${i}`,
        status: statuses[i]!,
        startTime: `${String(9 + i).padStart(2, '0')}:00`,
        endTime: `${String(9 + i).padStart(2, '0')}:20`,
        checkedInAt:
          statuses[i] === 'CheckedIn' ? '2030-09-15T22:00:00Z' : null,
      });
    await h.seed({
      appointmentId: 'other-date',
      appointmentDate: '2030-09-17',
      status: 'Completed',
    });
    const before = h.repo.exportRecords();
    const projection = h.repo.projectionStatus();
    await h.text('doctor');
    await h.click('today');
    expect(h.last().body).toContain('2030-09-16 (Asia/Karachi)');
    expect(h.choices()).toHaveLength(6);
    expect(h.choices()[3]!.title).toContain('12:00 PM');
    expect(h.choices()[3]!.id).toContain(`appointment:${detailId}`);
    await h.click(`appointment:${detailId}`);
    expect(h.last().body).toContain('12:00 PM–12:20 PM');
    expect(h.last().body).toContain('Synthetic 3');
    expect(h.last().body).not.toContain(detailId);
    expect(h.last().body).not.toContain('Reference:');
    expect(h.last().body).not.toContain('+12025550123');
    await h.click('summary');
    expect(h.last().body).toContain('Operational total: 4');
    for (const label of [
      'Scheduled',
      'Checked In',
      'Completed',
      'No Show',
      'Cancelled',
      'Rescheduled',
    ])
      expect(h.last().body).toContain(`${label}: 1`);
    expect(h.repo.exportRecords()).toEqual(before);
    expect(h.repo.projectionStatus()).toEqual(projection);
  }));

it('uses arrival then slot order for the queue and highlights the actual next patient', async () =>
  setup(async (h) => {
    await h.seed({
      appointmentId: 'later',
      patientName: 'Later Patient',
      status: 'CheckedIn',
      startTime: '09:00',
      endTime: '09:20',
      checkedInAt: '2030-09-15T22:10:00Z',
    });
    await h.seed({
      appointmentId: 'first',
      patientName: 'Next Patient',
      status: 'CheckedIn',
      startTime: '09:20',
      endTime: '09:40',
      checkedInAt: '2030-09-15T22:00:00Z',
    });
    await h.seed({
      appointmentId: 'second',
      status: 'CheckedIn',
      startTime: '09:40',
      endTime: '10:00',
      checkedInAt: '2030-09-15T22:00:00Z',
    });
    await h.text('doctor');
    await h.click('queue');
    expect(h.choices().map((c) => c.id.split(':').at(-1))).toEqual([
      'first',
      'second',
      'later',
    ]);
    expect(h.last().body).toContain('Next: Next Patient at 9:20 AM');
    expect(h.choices()[0]!.description).toContain('Next patient');
    await h.click('appointment:first');
    expect(h.last().body).toContain('Next patient\n');
  }));

it('handles empty lists, queues and summaries and paginates long lists safely', async () =>
  setup(async (h) => {
    await h.text('doctor');
    await h.click('today');
    expect(h.last().body).toContain('No appointments today');
    await h.click('queue');
    expect(h.last().body).toContain('No patients are waiting');
    await h.click('summary');
    expect(h.last().body).toContain('Operational total: 0');
    for (let i = 0; i < 12; i++)
      await h.seed({
        appointmentId: `page-${String(i).padStart(2, '0')}`,
        status: 'Completed',
      });
    await h.click('today');
    expect(h.choices()).toHaveLength(10);
    const stale = h.choices().at(-1)!.id;
    await h.click('more');
    expect(h.choices()).toHaveLength(3);
    await h.receive({ type: 'action', value: stale });
    expect(h.choices()).toHaveLength(3);
    h.advance(31 * 60_000);
    await h.receive({ type: 'action', value: h.choices()[0]!.id });
    expect(h.last().body).toBe('Doctor menu');
  }));

it('filters foreign clinic/date records defensively before reports or details', async () => {
  const local = appointment({
    appointmentId: 'local',
    appointmentDate: '2030-09-16',
  });
  const unit = {
    clinic,
    listAppointments: async () => [
      local,
      { ...local, appointmentId: 'foreign', clinicId: 'other' },
      { ...local, appointmentId: 'tomorrow', appointmentDate: '2030-09-17' },
    ],
  };
  const clock = { now: () => new Date('2030-09-16T03:00:00Z') };
  const operator = { operatorId: 'test-doctor', role: 'Doctor' as const };
  const incoming = (value: string, type: 'text' | 'action' = 'text') => ({
    id: 'synthetic',
    sender: doctor,
    timestamp: clock.now().getTime(),
    input: { type, value },
  });
  let result = await converseDoctor(
    null,
    incoming('doctor'),
    unit,
    clock,
    operator,
  );
  result = await converseDoctor(
    result.state,
    incoming(`${result.state.token}:today`, 'action'),
    unit,
    clock,
    operator,
  );
  expect(JSON.stringify(result.message)).toContain('appointment:local');
  expect(JSON.stringify(result.message)).not.toContain('foreign');
  expect(JSON.stringify(result.message)).not.toContain('tomorrow');
  await expect(
    converseDoctor(null, incoming('doctor'), unit, clock, {
      ...operator,
      role: 'Clerk',
    }),
  ).rejects.toMatchObject({ code: 'InvalidInput' });
});

it('rechecks Doctor role before sending a queued reply and resets sessions on role change', async () =>
  setup(async (h) => {
    await h.text('doctor');
    const choice = h.choices().find((c) => c.id.endsWith(':summary'))!;
    await h.store.enqueue({
      phoneNumberId: '100000000001',
      messages: [
        {
          id: 'wamid.deferred',
          sender: doctor,
          timestamp: h.clock.now().getTime(),
          input: { type: 'action', value: choice.id },
        },
      ],
      statuses: [],
    });
    await h.store.drain({
      send: async () => {
        throw new MetaFailure('RateLimited', 1000);
      },
    });
    const count = h.sent.length;
    h.auth(JSON.stringify([{ ...mapping[0], role: 'Clerk' }]));
    h.advance(60_000);
    await h.store.drain(h.messenger);
    expect(h.sent).toHaveLength(count);
    expect(
      h.storage.sql
        .exec(
          "SELECT state,last_error FROM wa_outbox WHERE id='wamid.deferred'",
        )
        .one(),
    ).toMatchObject({ state: 'failed', last_error: 'Configuration' });
    await h.text('menu');
    expect(h.choices().some((c) => c.title === 'Add Walk-in')).toBe(true);
    expect(h.choices().some((c) => c.title === 'Daily Summary')).toBe(false);
  }));
