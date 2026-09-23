import { env } from 'cloudflare:workers';
import { reset, runInDurableObject, evictDurableObject } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import type { ClinicProjectionSnapshot } from '../../src/ports/projection.js';
import type { WorkerEnv } from '../../src/adapters/cloudflare/worker.js';
import { SqliteClinicRepository } from '../../src/adapters/cloudflare/repository.js';
import { WhatsAppStore } from '../../src/adapters/whatsapp/store.js';
import { MetaClient } from '../../src/adapters/whatsapp/client.js';
import { configuredOperators } from '../../src/adapters/whatsapp/operators.js';
import type { Message, Input } from '../../src/adapters/whatsapp/models.js';
import { AppointmentService } from '../../src/appointments/service.js';
import { BlockTimeService } from '../../src/scheduling/block-time.js';
import { MetaFailure } from '../../src/adapters/whatsapp/models.js';
import { clinic, hours, appointment } from '../support/fixtures.js';
const sender = '12025550190';
const patient = '12025550123';
const config = JSON.stringify([
  {
    clinicId: clinic.clinicId,
    sender,
    role: 'Clerk',
    operatorId: 'demo-clerk',
  },
]);
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
  let now = Date.parse('2030-09-16T03:00:00Z');
  let seq = 0;
  const clock = { now: () => new Date(now) };
  const repo = new SqliteClinicRepository(storage, clinic.clinicId, clock);
  await repo.configure(
    { clinic, workingHours: [hours], blockedSlots: [] },
    'setup',
  );
  let auth = configuredOperators(config);
  let store = new WhatsAppStore(storage, repo, clock, auth);
  const sent: Message[] = [];
  const messenger = {
    send: async (_phone: string, _recipient: string, message: Message) => {
      await new MetaClient({ META_ACCESS_TOKEN: 'synthetic' }, async () =>
        Response.json({ messages: [{ id: 'wamid.synthetic' }] }),
      ).send(_phone, _recipient, message);
      sent.push(message);
      return `wamid.out.${sent.length}`;
    },
  };
  const receive = async (
    input: Input,
    who = sender,
    id = `wamid.in.${++seq}`,
  ) => {
    await store.enqueue({
      phoneNumberId: '100000000001',
      messages: [{ id, sender: who, timestamp: now, input }],
      statuses: [],
    });
    await store.drain(messenger);
    return id;
  };
  const last = () => sent.at(-1)!;
  const choices = () => {
    const m = last();
    return m.type === 'text' ? [] : m.choices;
  };
  const text = (value: string, who = sender) =>
    receive({ type: 'text', value }, who);
  const click = async (action: string) => {
    const c = choices().find((c) => c.id.endsWith(':' + action));
    expect(c, `${action}: ${last().body}`).toBeDefined();
    return receive({ type: 'action', value: c!.id });
  };
  const walk = async () => {
    await text('menu');
    await click('walk');
    await text('Synthetic Walk-in');
    await click('slot:09:00');
    await click('skip');
    await click('confirm');
    return repo.exportRecords().appointments[0]!;
  };
  return {
    storage,
    repo,
    clock,
    messenger,
    get store() {
      return store;
    },
    service: new AppointmentService(repo.asActor('demo-clerk'), clock, {
      next: () => crypto.randomUUID(),
    }),
    blocks: new BlockTimeService(repo.asActor('demo-clerk'), clock, {
      next: () => crypto.randomUUID(),
    }),
    sent,
    last,
    choices,
    text,
    click,
    receive,
    walk,
    advance: (ms: number) => {
      now += ms;
    },
    restart: () => {
      store = new WhatsAppStore(
        storage,
        new SqliteClinicRepository(storage, clinic.clinicId, clock),
        clock,
        auth,
      );
    },
    setAuth: (raw: string) => {
      auth = configuredOperators(raw);
      store = new WhatsAppStore(storage, repo, clock, auth);
    },
  };
}
it('authorizes by clinic, identity and role, never command text', async () =>
  setup(async (h) => {
    await h.text('staff');
    expect(h.last().body).toContain('Clerk');
    expect(h.choices()).toHaveLength(6);
    await h.text('staff', patient);
    expect(h.last().body).not.toContain('Clerk');
    h.setAuth(
      JSON.stringify([
        {
          clinicId: 'other_clinic',
          sender,
          role: 'Clerk',
          operatorId: 'other',
        },
      ]),
    );
    await h.text('clerk');
    expect(h.last().body).not.toContain('Clerk');
    h.setAuth(
      JSON.stringify([
        {
          clinicId: clinic.clinicId,
          sender,
          role: 'Doctor',
          operatorId: 'doctor',
        },
      ]),
    );
    await h.text('clerk');
    expect(h.last().body).not.toContain('Clerk');
  }));
it('books a generated walk-in once and checks in only explicitly; completes early', async () =>
  setup(async (h) => {
    const a = await h.walk();
    expect(a).toMatchObject({
      source: 'WalkIn',
      status: 'Scheduled',
      whatsappNumber: '',
    });
    const count = h.repo.exportRecords().activity.length;
    h.restart();
    await h.click('check-now');
    expect(h.repo.exportRecords().appointments[0]!.status).toBe('Scheduled');
    const confirm = h.choices().find((c) => c.id.endsWith(':confirm'))!.id;
    const id = await h.click('confirm');
    await h.receive({ type: 'action', value: confirm }, sender, id);
    await h.receive({ type: 'action', value: confirm });
    expect(h.repo.exportRecords().appointments[0]!.status).toBe('CheckedIn');
    expect(h.repo.exportRecords().activity).toHaveLength(count + 1);
    expect(h.last().body).toContain('Queue');
    await h.text('menu');
    await h.click('complete');
    await h.click(`appointment:${a.appointmentId}`);
    await h.click('confirm');
    const done = h.repo.exportRecords().appointments[0]!;
    expect(done.status).toBe('Completed');
    expect(done.completedAt).toBe(done.checkedInAt);
    expect(done.completedAt! < '2030-09-16T04:00:00.000Z').toBe(true);
  }));
it('requires explicit no-show confirmation and retains history', async () =>
  setup(async (h) => {
    const a = await h.walk();
    await h.text('menu');
    await h.click('noshow');
    await h.click(`appointment:${a.appointmentId}`);
    expect(h.repo.exportRecords().appointments[0]!.status).toBe('Scheduled');
    await h.click('confirm');
    expect(h.repo.exportRecords().appointments[0]!.status).toBe('NoShow');
  }));
it('persists an explicit block and projects it without direct Sheets writes', async () =>
  setup(async (h) => {
    await h.text('menu');
    await h.click('block');
    await h.text('2030-09-16');
    await h.text('09:00');
    await h.text('09:20');
    await h.click('skip');
    expect(h.repo.exportRecords().blockedSlots).toHaveLength(0);
    await h.click('confirm');
    expect(h.repo.exportRecords().blockedSlots).toHaveLength(1);
    expect(h.repo.exportRecords().activity.at(-1)!.action).toBe('TimeBlocked');
    expect(h.repo.projectionStatus().pending).toBe(2);
  }));
it('rejects malformed, ambiguous and duplicate authorization entries safely', () => {
  for (const raw of [
    'null',
    '{}',
    '[null]',
    '[3]',
    'invalid',
    JSON.stringify([
      { clinicId: clinic.clinicId, sender, role: 'Admin', operatorId: 'x' },
    ]),
    JSON.stringify([
      {
        clinicId: clinic.clinicId,
        sender: 'bad',
        role: 'Clerk',
        operatorId: 'x',
      },
    ]),
    JSON.stringify([...JSON.parse(config), ...JSON.parse(config)]),
  ])
    expect(
      configuredOperators(raw).resolve(clinic.clinicId, sender),
    ).toBeNull();
  expect(configuredOperators().resolve(clinic.clinicId, sender)).toBeNull();
  expect(configuredOperators(config).resolve(clinic.clinicId, sender)).toEqual({
    role: 'Clerk',
    operatorId: 'demo-clerk',
  });
  expect(configuredOperators(config).resolve('other', sender)).toBeNull();
  expect(
    configuredOperators(config).resolve(clinic.clinicId, patient),
  ).toBeNull();
});
it('keeps patient and clerk sessions separate across role changes and expiry', async () =>
  setup(async (h) => {
    await h.text('menu', patient);
    expect(h.choices().map((c) => c.title)).toContain('Book Appointment');
    await h.text('staff');
    const old = h.choices()[1]!.id;
    h.setAuth('[]');
    await h.receive({ type: 'action', value: old });
    expect(h.last().body).not.toContain('Clerk');
    expect(h.repo.exportRecords().appointments).toHaveLength(0);
    h.setAuth(config);
    await h.text('menu');
    await h.click('walk');
    h.advance(31 * 60_000);
    await h.text('Expired Example');
    expect(h.last().body).toContain('Clerk');
    expect(h.repo.exportRecords().patients).toHaveLength(0);
  }));
it('shows clinic-local today chronologically with status, safe pagination and no contacts', async () =>
  setup(async (h) => {
    for (let i = 0; i < 12; i++)
      await h.repo.runExclusive(clinic.clinicId, (u) =>
        u.insert(
          appointment({
            appointmentId: `synthetic-${String(i).padStart(2, '0')}`,
            appointmentDate: '2030-09-16',
            patientName: `Example ${i}`,
            startTime: `${String(9 + Math.floor(i / 3)).padStart(2, '0')}:${String((i % 3) * 20).padStart(2, '0')}`,
            endTime: `${String(9 + Math.floor(i / 3) + (i % 3 === 2 ? 1 : 0)).padStart(2, '0')}:${String(((i % 3) * 20 + 20) % 60).padStart(2, '0')}`,
            status:
              i === 0 ? 'Cancelled' : i === 1 ? 'Rescheduled' : 'Completed',
          }),
        ),
      );
    await h.text('menu');
    await h.click('today');
    expect(h.last().body).toContain('2030-09-16');
    expect(h.choices()).toHaveLength(10);
    expect(h.choices()[0]!.title).toContain('9:00 AM');
    expect(h.choices()[0]!.description).toContain('Cancelled');
    expect(h.choices()[1]!.description).toContain('Rescheduled');
    expect(JSON.stringify(h.last())).not.toContain('+1202555');
    await h.click('more');
    expect(h.choices()).toHaveLength(3);
    await h.click('appointment:synthetic-09');
    expect(h.last().body).toContain('Completed');
  }));
it('handles an empty day and clinic-local date differing from UTC', async () =>
  setup(async (h) => {
    h.advance(-4 * 60 * 60_000);
    await h.text('menu');
    await h.click('today');
    expect(h.last().body).toContain('No eligible appointments');
    await h.repo.runExclusive(clinic.clinicId, (u) =>
      u.insert(
        appointment({ appointmentDate: '2030-09-16', status: 'Completed' }),
      ),
    );
    await h.click('today');
    expect(h.last().body).toContain('2030-09-16');
  }));
it('rechecks a walk-in slot lost before confirmation and refreshes alternatives', async () =>
  setup(async (h) => {
    await h.text('menu');
    await h.click('walk');
    await h.text('Synthetic Name');
    await h.click('slot:09:00');
    await h.text('Arrival assistance');
    await h.service.book({
      clinicId: clinic.clinicId,
      patientId: 'competitor',
      patientName: 'Other Example',
      whatsappNumber: '+12025550124',
      appointmentDate: '2030-09-16',
      startTime: '09:00',
      source: 'Phone',
      createdBy: 'fixture',
    });
    await h.click('confirm');
    expect(h.last().body).toContain('no longer available');
    expect(h.repo.exportRecords().appointments).toHaveLength(1);
    expect(h.choices().some((c) => c.id.endsWith('slot:09:00'))).toBe(false);
    await h.click('slot:09:20');
    await h.text('Arrival assistance');
    await h.click('confirm');
    expect(
      h.repo.exportRecords().appointments.find((a) => a.source === 'WalkIn')!
        .reason,
    ).toBe('Arrival assistance');
  }));
it('rejects off-grid forged actions and duplicate walk-in confirmation', async () =>
  setup(async (h) => {
    await h.text('menu');
    await h.click('walk');
    await h.text('Synthetic Name');
    const token = h.choices()[0]!.id.split(':')[0];
    await h.receive({ type: 'action', value: `${token}:slot:09:01` });
    expect(h.repo.exportRecords().appointments).toHaveLength(0);
    await h.click('slot:09:00');
    await h.click('skip');
    const value = h.choices()[0]!.id;
    const id = await h.click('confirm');
    await h.receive({ type: 'action', value }, sender, id);
    await h.receive({ type: 'action', value });
    expect(h.repo.exportRecords().appointments).toHaveLength(1);
    expect(
      h.repo
        .exportRecords()
        .activity.filter((e) => e.action === 'AppointmentCreated'),
    ).toHaveLength(1);
    await expect(
      h.service.book({
        clinicId: clinic.clinicId,
        patientId: 'offgrid',
        patientName: 'Example',
        whatsappNumber: '',
        appointmentDate: '2030-09-16',
        startTime: '09:21',
        source: 'WalkIn',
        createdBy: 'demo-clerk',
      }),
    ).rejects.toMatchObject({ code: 'SlotOffGrid' });
  }));
it.each(['inactive', 'suspended'] as const)(
  'blocks new walk-ins but permits existing operations and blocks under %s',
  async (status) =>
    setup(async (h) => {
      const a = await h.walk();
      await h.repo.configure(
        {
          clinic: { ...clinic, subscriptionStatus: status },
          workingHours: [hours],
          blockedSlots: [],
        },
        'setup',
      );
      await h.text('menu');
      await h.click('walk');
      expect(h.last().body).toContain('New reservations are unavailable');
      await h.click('today');
      expect(h.choices()[0]!.id).toContain(a.appointmentId);
      await h.text('menu');
      await h.click('checkin');
      await h.click(`appointment:${a.appointmentId}`);
      await h.click('confirm');
      expect(h.repo.exportRecords().appointments[0]!.status).toBe('CheckedIn');
      await h.text('menu');
      await h.click('complete');
      await h.click(`appointment:${a.appointmentId}`);
      await h.click('confirm');
      expect(h.repo.exportRecords().appointments[0]!.status).toBe('Completed');
      await h.blocks.create({
        clinicId: clinic.clinicId,
        date: '2030-09-16',
        startTime: '09:20',
        endTime: '09:40',
        reason: '',
      });
      expect(h.repo.exportRecords().blockedSlots).toHaveLength(1);
    }),
);
it('rechecks subscription at walk-in confirmation', async () =>
  setup(async (h) => {
    await h.text('menu');
    await h.click('walk');
    await h.text('Synthetic Name');
    await h.click('slot:09:00');
    await h.click('skip');
    await h.repo.configure(
      {
        clinic: { ...clinic, subscriptionStatus: 'inactive' },
        workingHours: [hours],
        blockedSlots: [],
      },
      'setup',
    );
    await h.click('confirm');
    expect(h.repo.exportRecords().appointments).toHaveLength(0);
    expect(h.last().body).toContain('New reservations');
  }));
it('never completes Scheduled directly, or marks no-show without confirmation', async () =>
  setup(async (h) => {
    const a = await h.walk();
    await h.text('menu');
    await h.click('complete');
    expect(h.last().body).toContain('No eligible');
    await h.click('noshow');
    await h.click(`appointment:${a.appointmentId}`);
    h.advance(60 * 60_000);
    expect(h.repo.exportRecords().appointments[0]!.status).toBe('Scheduled');
    await h.text('menu');
    await h.click('noshow');
    await h.click(`appointment:${a.appointmentId}`);
    const value = h.choices()[0]!.id;
    await h.click('confirm');
    await h.receive({ type: 'action', value });
    expect(
      h.repo
        .exportRecords()
        .activity.filter((e) => e.action === 'AppointmentNoShow'),
    ).toHaveLength(1);
  }));
it('revalidates lifecycle status after selection and records operator actor ID', async () =>
  setup(async (h) => {
    const a = await h.walk();
    await h.text('menu');
    await h.click('checkin');
    await h.click(`appointment:${a.appointmentId}`);
    await h.service.transition({
      clinicId: clinic.clinicId,
      appointmentId: a.appointmentId,
      to: 'Cancelled',
      actor: { id: 'other-clerk', role: 'Clerk' },
    });
    await h.click('confirm');
    expect(h.last().body).toContain('no longer valid');
    expect(
      h.repo
        .exportRecords()
        .activity.some((e) => e.action === 'AppointmentCheckedIn'),
    ).toBe(false);
    expect(
      h.repo
        .exportRecords()
        .activity.find((e) => e.action === 'AppointmentCreated')!.actorId,
    ).toBe('demo-clerk');
  }));
it('blocks revoke queued staff replies and stale privileged confirmations', async () =>
  setup(async (h) => {
    await h.store.enqueue({
      phoneNumberId: '100000000001',
      messages: [
        {
          id: 'wamid.revocation',
          sender,
          timestamp: h.clock.now().getTime(),
          input: { type: 'text', value: 'staff' },
        },
      ],
      statuses: [],
    });
    await h.store.drain({
      send: async () => {
        throw new MetaFailure('RateLimited', 1000);
      },
    });
    h.setAuth('[]');
    h.advance(2000);
    await h.store.drain(h.messenger);
    expect(h.sent).toHaveLength(0);
    expect(
      h.storage.sql
        .exec("SELECT state FROM wa_outbox WHERE id='wamid.revocation'")
        .one().state,
    ).toBe('failed');
  }));
it('status webhooks do not create clerk conversation or outbound replies', async () =>
  setup(async (h) => {
    await h.store.enqueue({
      phoneNumberId: '100000000001',
      messages: [],
      statuses: [
        {
          id: 'wamid.unrelated',
          recipient: sender,
          status: 'read',
          timestamp: h.clock.now().getTime(),
        },
      ],
    });
    await h.store.drain(h.messenger);
    expect(h.sent).toHaveLength(0);
    expect(
      h.storage.sql.exec('SELECT COUNT(*) AS n FROM wa_conversations').one().n,
    ).toBe(0);
  }));
it.each([
  ['09:10', '09:30', 'SlotConflict'],
  ['08:00', '08:20', 'SlotInPast'],
  ['09:30', '09:30', 'InvalidSchedule'],
  ['09:50', '10:10', 'SlotOutsideWorkingHours'],
  ['bad', '09:40', 'InvalidInput'],
])('rejects block %s–%s with %s', async (startTime, endTime, code) =>
  setup(async (h) => {
    await h.walk();
    const before = h.repo.exportRecords();
    await expect(
      h.blocks.create({
        clinicId: clinic.clinicId,
        date: '2030-09-16',
        startTime: startTime!,
        endTime: endTime!,
        reason: '',
      }),
    ).rejects.toMatchObject({ code });
    expect(h.repo.exportRecords()).toEqual(before);
  }),
);
it('blocks exclude availability; duplicate confirmation does not create a second block/activity', async () =>
  setup(async (h) => {
    await h.text('menu');
    await h.click('block');
    await h.text('2030-09-16');
    await h.text('09:20');
    await h.text('09:40');
    await h.text('Operational pause');
    const value = h.choices()[0]!.id;
    const id = await h.click('confirm');
    h.restart();
    await h.receive({ type: 'action', value }, sender, id);
    await h.receive({ type: 'action', value });
    expect(h.repo.exportRecords().blockedSlots).toHaveLength(1);
    expect(
      h.repo.exportRecords().activity.filter((e) => e.action === 'TimeBlocked'),
    ).toHaveLength(1);
    expect(
      (await h.service.availability(clinic.clinicId, '2030-09-16')).map(
        (s) => s.startTime,
      ),
    ).toEqual(['09:00', '09:40']);
  }));
it('a Sheets failure cannot roll back a clerk mutation', async () =>
  setup(async (h) => {
    await h.walk();
    await h.repo.flushProjection({
      applySnapshot: async () => {
        throw Error('synthetic outage');
      },
    });
    expect(h.repo.exportRecords().appointments).toHaveLength(1);
    expect(h.repo.projectionStatus().failed).toBeGreaterThan(0);
  }));
it('rolls back block, session and reply on commit failure, then retries once after restart', async () =>
  setup(async (h) => {
    await h.text('menu');
    await h.click('block');
    await h.text('2030-09-16');
    await h.text('09:20');
    await h.text('09:40');
    await h.click('skip');
    const before = h.repo.exportRecords();
    const replies = h.sent.length;
    h.storage.sql.exec(
      "CREATE TRIGGER fail_clerk_audit BEFORE INSERT ON activity_log BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END",
    );
    await h.click('confirm');
    expect(h.repo.exportRecords()).toEqual(before);
    expect(h.sent).toHaveLength(replies);
    h.storage.sql.exec('DROP TRIGGER fail_clerk_audit');
    h.restart();
    h.advance(31_000);
    await h.store.drain(h.messenger);
    expect(h.repo.exportRecords().blockedSlots).toHaveLength(1);
    expect(h.sent).toHaveLength(replies + 1);
  }));
it('recovers a clerk confirmation after actual DO eviction without duplicating its mutation', async () => {
  const stub = (env as WorkerEnv).CLINICS.getByName(clinic.clinicId);
  let pending: Input = { type: 'text', value: 'unused' };
  await runInDurableObject(stub, async (_, state) => {
    const h = await harness(state.storage);
    await h.text('staff');
    await h.click('walk');
    await h.text('Recovery Example');
    await h.click('slot:09:00');
    await h.click('skip');
    pending = { type: 'action', value: h.choices()[0]!.id };
    await h.store.enqueue({
      phoneNumberId: '100000000001',
      messages: [
        {
          id: 'wamid.eviction.confirm',
          sender,
          timestamp: h.clock.now().getTime(),
          input: pending,
        },
      ],
      statuses: [],
    });
  });
  await evictDurableObject(stub);
  await runInDurableObject(stub, async (_, state) => {
    const clock = { now: () => new Date('2030-09-16T03:00:00Z') };
    const repo = new SqliteClinicRepository(
      state.storage,
      clinic.clinicId,
      clock,
    );
    const store = new WhatsAppStore(
      state.storage,
      repo,
      clock,
      configuredOperators(config),
    );
    let sends = 0;
    const messenger = {
      send: async () => {
        sends++;
        return 'wamid.recovered';
      },
    };
    await store.drain(messenger);
    await store.enqueue({
      phoneNumberId: '100000000001',
      messages: [
        {
          id: 'wamid.eviction.confirm',
          sender,
          timestamp: clock.now().getTime(),
          input: pending,
        },
      ],
      statuses: [],
    });
    await store.drain(messenger);
    expect(repo.exportRecords().appointments).toHaveLength(1);
    expect(
      repo
        .exportRecords()
        .activity.filter((e) => e.action === 'AppointmentCreated'),
    ).toHaveLength(1);
    expect(sends).toBe(1);
  });
});
it('reports queue ordering by arrival ahead of scheduled time and protects completion timestamps', async () =>
  setup(async (h) => {
    const a = await h.walk();
    const b = await h.service.book({
      clinicId: clinic.clinicId,
      patientId: 'second',
      patientName: 'Second Example',
      whatsappNumber: '',
      appointmentDate: '2030-09-16',
      startTime: '09:20',
      source: 'WalkIn',
      createdBy: 'demo-clerk',
    });
    await h.text('menu');
    await h.click('checkin');
    await h.click(`appointment:${b.appointmentId}`);
    await h.click('confirm');
    expect(h.last().body).toContain('Queue position: 1');
    h.advance(1000);
    await h.click('checkin');
    await h.click(`appointment:${a.appointmentId}`);
    await h.click('confirm');
    expect(h.last().body).toContain('Queue position: 2');
    await h.click('complete');
    await h.click(`appointment:${a.appointmentId}`);
    h.advance(-500);
    await h.click('confirm');
    expect(
      h.repo
        .exportRecords()
        .appointments.find((x) => x.appointmentId === a.appointmentId)!.status,
    ).toBe('CheckedIn');
    h.advance(1000);
    await h.click('complete');
    await h.click(`appointment:${a.appointmentId}`);
    const value = h.choices()[0]!.id;
    await h.click('confirm');
    await h.receive({ type: 'action', value });
    expect(
      h.repo
        .exportRecords()
        .activity.filter((e) => e.action === 'AppointmentCompleted'),
    ).toHaveLength(1);
  }));
it('rejects block overlap with CheckedIn appointments and existing blocks', async () =>
  setup(async (h) => {
    const a = await h.walk();
    await h.service.transition({
      clinicId: clinic.clinicId,
      appointmentId: a.appointmentId,
      to: 'CheckedIn',
      actor: { id: 'demo-clerk', role: 'Clerk' },
    });
    await h.text('menu');
    await h.click('block');
    await h.text('2030-09-16');
    await h.text('09:10');
    await h.text('09:30');
    await h.click('skip');
    await h.click('confirm');
    expect(h.last().body).toContain(
      'Handle the existing appointment separately',
    );
    await h.blocks.create({
      clinicId: clinic.clinicId,
      date: '2030-09-16',
      startTime: '09:20',
      endTime: '09:40',
      reason: '',
    });
    await h.click('block');
    await h.text('2030-09-16');
    await h.text('09:30');
    await h.text('09:50');
    await h.click('skip');
    await h.click('confirm');
    expect(h.last().body).toContain('already blocked');
    expect(h.repo.exportRecords().blockedSlots).toHaveLength(1);
  }));
it('rejects out-of-horizon, break and non-working-day blocks and retains prior state', async () =>
  setup(async (h) => {
    const make = (date: string, startTime = '09:00', endTime = '09:20') =>
      h.blocks.create({
        clinicId: clinic.clinicId,
        date,
        startTime,
        endTime,
        reason: '',
      });
    await expect(make('2030-09-15')).rejects.toMatchObject({
      code: 'DateOutsideBookingHorizon',
    });
    await expect(make('2040-01-01')).rejects.toMatchObject({
      code: 'DateOutsideBookingHorizon',
    });
    await expect(make('2030-09-17')).rejects.toMatchObject({
      code: 'SlotOutsideWorkingHours',
    });
    await h.repo.configure(
      {
        clinic,
        workingHours: [
          { ...hours, breaks: [{ startTime: '09:10', endTime: '09:20' }] },
        ],
        blockedSlots: [],
      },
      'setup',
    );
    await expect(make('2030-09-16')).rejects.toMatchObject({
      code: 'SlotOutsideWorkingHours',
    });
    expect(h.repo.exportRecords().blockedSlots).toHaveLength(0);
  }));
it('persists contactless walk-ins without weakening other booking contact validation', async () =>
  setup(async (h) => {
    await expect(
      h.service.book({
        clinicId: clinic.clinicId,
        patientId: 'normal',
        patientName: 'Example',
        whatsappNumber: '',
        appointmentDate: '2030-09-16',
        startTime: '09:00',
        source: 'WhatsApp',
        createdBy: 'test',
      }),
    ).rejects.toMatchObject({ code: 'InvalidInput' });
    const a = await h.walk();
    expect(a.whatsappNumber).toBe('');
    expect(h.repo.exportRecords().patients[0]!.whatsappNumber).toBe('');
    await h.text('menu', patient);
    await h.receive(
      {
        type: 'action',
        value: h.choices().find((c) => c.title === 'My Appointment')!.id,
      },
      patient,
    );
    expect(h.last().body).not.toContain(a.appointmentId);
  }));
it('enforces the block commit conflict backstop even for a trusted writer bypassing validation', async () =>
  setup(async (h) => {
    await h.walk();
    const before = h.repo.exportRecords();
    await expect(
      h.repo.runWithCommit(
        async (u) => {
          await u.insertBlockedSlot!({
            clinicId: clinic.clinicId,
            id: 'bad-block',
            date: '2030-09-16',
            startTime: '09:10',
            endTime: '09:30',
            reason: '',
          });
        },
        () => {},
      ),
    ).rejects.toMatchObject({ code: 'SlotConflict' });
    expect(h.repo.exportRecords()).toEqual(before);
    await expect(
      h.repo.runWithCommit(
        async (u) => {
          await u.insertBlockedSlot!({
            clinicId: 'other_clinic',
            id: 'cross',
            date: '2030-09-16',
            startTime: '09:20',
            endTime: '09:40',
            reason: '',
          });
        },
        () => {},
      ),
    ).rejects.toMatchObject({ code: 'InvalidInput' });
  }));
it('handles long names, unsupported messages, restart and slot pagination safely', async () =>
  setup(async (h) => {
    await h.repo.configure(
      {
        clinic,
        workingHours: [{ ...hours, endTime: '18:00' }],
        blockedSlots: [],
      },
      'setup',
    );
    await h.text('staff');
    await h.click('walk');
    await h.text('x'.repeat(81));
    expect(h.last().body).toContain('at most 80');
    await h.text('Example');
    expect(h.choices()).toHaveLength(10);
    await h.click('more');
    expect(h.choices()[0]!.title).toContain('12:00');
    await h.receive({ type: 'unsupported', value: '' });
    expect(h.choices()[0]!.title).toContain('12:00');
    await h.text('restart');
    expect(h.last().body).toBe('Clerk menu');
    await h.click('walk');
    await h.text('Example');
    await h.click('slot:09:00');
    await h.text('x'.repeat(161));
    expect(h.last().body).toContain('at most 160');
    await h.click('skip');
    await h.click('abort');
    expect(h.repo.exportRecords().appointments).toHaveLength(0);
  }));
it('projects clerk appointment, contactless patient, activity and block in one revisioned snapshot', async () =>
  setup(async (h) => {
    await h.walk();
    await h.text('menu');
    await h.click('block');
    await h.text('2030-09-16');
    await h.text('09:20');
    await h.text('09:40');
    await h.click('skip');
    await h.click('confirm');
    let last: ClinicProjectionSnapshot | undefined;
    await h.repo.flushProjection({
      applySnapshot: async (snapshot) => {
        last = snapshot;
      },
    });
    expect(last!.revision).toBe(3);
    expect(last!.sheets.Appointments).toHaveLength(1);
    expect(last!.sheets.Patients).toHaveLength(1);
    expect(last!.sheets.Blocked_Slots).toHaveLength(1);
    expect(last!.sheets.Activity_Log).toHaveLength(3);
    for (const sheet of Object.values(last!.sheets))
      for (const row of sheet) {
        expect(row.cells[1]).toBe(3);
        expect(row.cells[2]).toBe(clinic.clinicId);
      }
    expect(
      h.repo
        .exportRecords()
        .activity.slice(1)
        .every((a) => a.actorId === 'demo-clerk'),
    ).toBe(true);
    expect(h.repo.projectionStatus().pending).toBe(0);
  }));
it('rechecks active appointments when a block confirmation races a booking', async () =>
  setup(async (h) => {
    await h.text('menu');
    await h.click('block');
    await h.text('2030-09-16');
    await h.text('09:00');
    await h.text('09:40');
    await h.click('skip');
    await h.service.book({
      clinicId: clinic.clinicId,
      patientId: 'race-example',
      patientName: 'Race Example',
      whatsappNumber: '',
      appointmentDate: '2030-09-16',
      startTime: '09:20',
      source: 'WalkIn',
      createdBy: 'other-clerk',
    });
    await h.click('confirm');
    expect(h.last().body).toContain('overlaps an active appointment');
    expect(h.repo.exportRecords().blockedSlots).toHaveLength(0);
    expect(h.repo.exportRecords().appointments[0]!.status).toBe('Scheduled');
    expect(
      h.repo.exportRecords().activity.filter((e) => e.action === 'TimeBlocked'),
    ).toHaveLength(0);
  }));

it('rechecks daily capacity on walk-in confirmation without staff override or partial patient writes', async () =>
  setup(async (h) => {
    await h.repo.configure(
      {
        clinic: { ...clinic, dailyAppointmentLimit: 1 },
        workingHours: [hours],
        blockedSlots: [],
      },
      'test',
    );
    await h.text('clerk');
    await h.click('walk');
    await h.text('Synthetic Walk-in');
    await h.click('slot:09:00');
    await h.click('skip');
    await h.service.book({
      clinicId: clinic.clinicId,
      patientId: 'other',
      patientName: 'Synthetic Other',
      whatsappNumber: '+12025550124',
      appointmentDate: '2030-09-16',
      startTime: '09:20',
      source: 'WhatsApp',
      createdBy: 'patient',
    });
    const before = h.repo.exportRecords();
    await h.click('confirm');
    expect(h.last().body).toContain('fully booked');
    expect(h.repo.exportRecords()).toEqual(before);
  }));

it('formats clerk walk-ins, appointment lists/details and block ranges without changing stored times', async () =>
  setup(async (h) => {
    await h.repo.configure(
      {
        clinic,
        workingHours: [{ ...hours, startTime: '11:40', endTime: '14:00' }],
        blockedSlots: [],
      },
      'test',
    );
    await h.text('clerk');
    await h.click('walk');
    await h.text('Synthetic Walk-in');
    expect(h.choices()).toContainEqual(
      expect.objectContaining({
        title: '11:40 AM–12:00 PM',
        id: expect.stringContaining(':slot:11:40'),
      }),
    );
    await h.click('slot:12:00');
    await h.click('skip');
    expect(h.last().body).toContain('2030-09-16 12:00 PM');
    await h.click('confirm');
    expect(h.last().body).toContain(
      'Walk-in booked: 12:00 PM–12:20 PM (Asia/Karachi)',
    );
    const a = h.repo.exportRecords().appointments[0]!;
    expect(a).toMatchObject({ startTime: '12:00', endTime: '12:20' });
    await h.text('menu');
    await h.click('today');
    expect(h.choices()[0]!.title).toContain('12:00 PM');
    await h.click(`appointment:${a.appointmentId}`);
    expect(h.last().body).toContain('12:00 PM–12:20 PM (Asia/Karachi)');
    await h.click('block');
    await h.text('2030-09-16');
    await h.text('13:00');
    await h.text('13:20');
    await h.click('skip');
    expect(h.last().body).toContain('2030-09-16 1:00 PM–1:20 PM');
    await h.click('confirm');
    expect(h.last().body).toContain('Time blocked.');
    expect(h.repo.exportRecords().blockedSlots[0]).toMatchObject({
      startTime: '13:00',
      endTime: '13:20',
    });
  }));
