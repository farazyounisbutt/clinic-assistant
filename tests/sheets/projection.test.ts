import { describe, expect, it } from 'vitest';
import { GoogleSheetsProjection } from '../../src/adapters/sheets/projection.js';
import { GoogleSheetsClient } from '../../src/adapters/sheets/client.js';
import { projectionSnapshot } from '../../src/projection/sheets.js';
import type { ClinicRecords } from '../../src/ports/projection.js';
import { clinic, hours, appointment } from '../support/fixtures.js';
import { FakeGoogleSheets } from './fake-google.js';
const target = { clinicId: clinic.clinicId, spreadsheetId: 'synthetic-target' };
const data: ClinicRecords = {
  clinic,
  workingHours: [hours],
  blockedSlots: [
    {
      id: 'synthetic-block',
      clinicId: clinic.clinicId,
      date: '2030-09-16',
      startTime: '10:00',
      endTime: '10:20',
      reason: 'Unavailable',
    },
  ],
  appointments: [appointment()],
  patients: [
    {
      patientId: 'patient-example',
      clinicId: clinic.clinicId,
      name: 'Example',
      whatsappNumber: '+12025550123',
      createdAt: '2030-09-16T03:00:00Z',
    },
  ],
  activity: [
    {
      eventId: '1:1',
      clinicId: clinic.clinicId,
      timestamp: '2030-09-16T03:00:00Z',
      actorId: 'clerk-example',
      action: 'AppointmentCreated',
      appointmentId: 'synthetic-appointment',
      detail: 'Operational event',
    },
  ],
};
function setup(ready = true) {
  const fake = new FakeGoogleSheets(clinic.clinicId, ready);
  const adapter = new GoogleSheetsProjection(
    target,
    new GoogleSheetsClient(
      { getToken: async () => 'synthetic-token', invalidate: () => {} },
      fake.fetch,
    ),
  );
  return { fake, adapter };
}
describe('Google Sheets schema and bootstrap', () => {
  it('validates all six exact headers and the clinic/version marker', async () => {
    const { adapter } = setup();
    expect(await adapter.validate()).toMatchObject({
      schemaVersion: 1,
      clinicId: clinic.clinicId,
      revision: 0,
    });
  });
  it.each(['missing', 'headers', 'version', 'foreign'] as const)(
    'rejects %s without writing',
    async (mode) => {
      const { adapter, fake } = setup();
      if (mode === 'missing') fake.sheets.pop();
      if (mode === 'headers') fake.sheets[0]!.rows[0]![0] = 'Unexpected';
      if (mode === 'version')
        fake.metadata[0]!.metadataValue = JSON.stringify({
          schemaVersion: 2,
          clinicId: clinic.clinicId,
          revision: 0,
        });
      if (mode === 'foreign')
        fake.metadata[0]!.metadataValue = JSON.stringify({
          schemaVersion: 1,
          clinicId: 'other_clinic',
          revision: 0,
        });
      await expect(adapter.validate()).rejects.toHaveProperty('category');
      expect(fake.writes).toBe(0);
    },
  );
  it('explicitly bootstraps an empty target and safely repeats bootstrap', async () => {
    const { adapter, fake } = setup(false);
    await adapter.bootstrap();
    await adapter.bootstrap();
    expect(fake.writes).toBe(1);
    expect(await adapter.validate()).toMatchObject({ revision: 0 });
    expect(
      fake.sheets.find((s) => s.properties.title === 'Sheet1'),
    ).toBeDefined();
  });
  it('refuses nonempty bootstrap without touching clinic content', async () => {
    const { adapter, fake } = setup(false);
    fake.sheets[0]!.rows = [['Existing clinic content']];
    await expect(adapter.bootstrap()).rejects.toMatchObject({
      category: 'Schema',
    });
    expect(fake.writes).toBe(0);
  });
});
describe('stable-key projection', () => {
  it('inserts then updates all operational tables without duplicate logical rows', async () => {
    const { adapter, fake } = setup();
    await adapter.applySnapshot(projectionSnapshot(clinic.clinicId, 1, data));
    const newer = projectionSnapshot(clinic.clinicId, 2, {
      ...data,
      appointments: data.appointments.map((a) => ({
        ...a,
        status: 'Cancelled',
      })),
      patients: data.patients.map((p) => ({ ...p, name: 'Updated Example' })),
    });
    await adapter.applySnapshot(newer);
    await adapter.applySnapshot(newer);
    for (const name of [
      'Clinic_Settings',
      'Working_Hours',
      'Blocked_Slots',
      'Appointments',
      'Patients',
      'Activity_Log',
    ] as const)
      expect(fake.rows(name)).toHaveLength(1);
    expect(fake.rows('Appointments')[0]).toContain('Cancelled');
    expect(fake.rows('Patients')[0]).toContain('Updated Example');
    expect(fake.writes).toBe(2);
  });
  it('never overwrites a newer revision and ignores a stale snapshot', async () => {
    const { adapter, fake } = setup();
    await adapter.applySnapshot(projectionSnapshot(clinic.clinicId, 9, data));
    await adapter.applySnapshot(
      projectionSnapshot(clinic.clinicId, 8, { ...data, appointments: [] }),
    );
    expect(fake.rows('Appointments')).toHaveLength(1);
    expect(fake.writes).toBe(1);
  });
  it('retry after acknowledgement loss is a no-op and Activity_Log is deduplicated', async () => {
    const { adapter, fake } = setup();
    fake.loseAcknowledgement = true;
    await expect(
      adapter.applySnapshot(projectionSnapshot(clinic.clinicId, 1, data)),
    ).rejects.toMatchObject({ category: 'Transient' });
    await adapter.applySnapshot(projectionSnapshot(clinic.clinicId, 1, data));
    expect(fake.rows('Activity_Log')).toHaveLength(1);
    expect(fake.writes).toBe(1);
  });
  it('removes obsolete managed rows and writes formula-looking strings as text', async () => {
    const { adapter, fake } = setup();
    await adapter.applySnapshot(projectionSnapshot(clinic.clinicId, 1, data));
    await adapter.applySnapshot(
      projectionSnapshot(clinic.clinicId, 2, {
        ...data,
        blockedSlots: [],
        patients: data.patients.map((p) => ({
          ...p,
          name: '=synthetic-label',
        })),
      }),
    );
    expect(fake.rows('Blocked_Slots')).toEqual([]);
    expect(fake.rows('Patients')[0]).toContain('=synthetic-label');
  });
  it('rejects malformed payloads and foreign clinic snapshots before HTTP', async () => {
    const { adapter, fake } = setup();
    const snapshot = projectionSnapshot('other_clinic', 1, data);
    await expect(adapter.applySnapshot(snapshot)).rejects.toMatchObject({
      category: 'MalformedPayload',
    });
    expect(fake.writes).toBe(0);
  });
});

it('rebuilds the row index after sorting and preserves stable IDs while growing capacity', async () => {
  const { adapter, fake } = setup();
  const initial = projectionSnapshot(clinic.clinicId, 1, {
    ...data,
    appointments: [appointment(), appointment({ appointmentId: 'second' })],
  });
  await adapter.applySnapshot(initial);
  const sheet = fake.sheets.find((s) => s.properties.title === 'Appointments')!;
  [sheet.rows[1], sheet.rows[2]] = [sheet.rows[2]!, sheet.rows[1]!];
  sheet.properties.gridProperties.rowCount = 3;
  await adapter.applySnapshot(
    projectionSnapshot(clinic.clinicId, 2, {
      ...data,
      appointments: [
        appointment({ status: 'Cancelled' }),
        appointment({ appointmentId: 'second' }),
        appointment({ appointmentId: 'third' }),
      ],
    }),
  );
  expect(fake.rows('Appointments').map((r) => r[0])).toEqual([
    'second',
    'existing',
    'third',
  ]);
  expect(fake.rows('Appointments')[1]).toContain('Cancelled');
  expect(sheet.properties.gridProperties.rowCount).toBe(4);
});
it('refuses duplicate or malformed managed rows without overwriting unexpected content', async () => {
  const { adapter, fake } = setup();
  await adapter.applySnapshot(projectionSnapshot(clinic.clinicId, 1, data));
  const sheet = fake.sheets.find((s) => s.properties.title === 'Appointments')!;
  sheet.rows.push([...sheet.rows[1]!]);
  await expect(
    adapter.applySnapshot(projectionSnapshot(clinic.clinicId, 2, data)),
  ).rejects.toMatchObject({ category: 'Schema' });
  expect(fake.writes).toBe(1);
});
it('checks record revisions even if the spreadsheet marker is older', async () => {
  const { adapter, fake } = setup();
  await adapter.applySnapshot(projectionSnapshot(clinic.clinicId, 4, data));
  fake.metadata[0]!.metadataValue = JSON.stringify({
    schemaVersion: 1,
    clinicId: clinic.clinicId,
    revision: 1,
  });
  await expect(
    adapter.applySnapshot(
      projectionSnapshot(clinic.clinicId, 3, { ...data, appointments: [] }),
    ),
  ).rejects.toMatchObject({ category: 'Schema' });
  expect(fake.writes).toBe(1);
  expect(fake.rows('Appointments')).toHaveLength(1);
});
it('refuses an oversized snapshot instead of splitting a revision across batches', async () => {
  const { adapter, fake } = setup();
  const large = {
    ...data,
    patients: data.patients.map((p) => ({ ...p, name: 'x'.repeat(1_800_001) })),
  };
  await expect(
    adapter.applySnapshot(projectionSnapshot(clinic.clinicId, 1, large)),
  ).rejects.toMatchObject({ category: 'MalformedPayload' });
  expect(fake.writes).toBe(0);
});
