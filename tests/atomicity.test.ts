import { expect, it } from 'vitest';
import type { ClinicAppointmentUnitOfWork } from '../src/ports/repositories.js';
import { InMemoryAppointmentStore } from './support/in-memory-store.js';
import { AppointmentService } from '../src/appointments/service.js';
import { appointment, clinic, date, hours, now } from './support/fixtures.js';

function store() {
  return new InMemoryAppointmentStore({
    clinics: [clinic, { ...clinic, clinicId: 'other' }],
    workingHours: [hours],
  });
}

it('rejects overlapping active writes even if a caller bypasses the availability helper', async () => {
  const repo = store();
  await expect(
    repo.runExclusive(clinic.clinicId, async (unit) => {
      await unit.insert(appointment());
      await unit.insert(
        appointment({
          appointmentId: 'second',
          startTime: '09:10',
          endTime: '09:30',
        }),
      );
    }),
  ).rejects.toMatchObject({ code: 'SlotConflict' });
  expect(await repo.listByDate(clinic.clinicId, date)).toEqual([]);
});
it('rejects cross-clinic inserts and replacements', async () => {
  const repo = store();
  for (const method of ['insert', 'replace'] as const) {
    await expect(
      repo.runExclusive(clinic.clinicId, async (unit) => {
        await unit[method](appointment({ clinicId: 'other' }));
      }),
    ).rejects.toMatchObject({ code: 'InvalidInput' });
  }
});
it('allows equivalent slots in different clinics and isolates ID lookup', async () => {
  const repo = store();
  await Promise.all(
    [clinic.clinicId, 'other'].map((clinicId) =>
      repo.runExclusive(clinicId, async (unit) => {
        await unit.insert(appointment({ clinicId }));
      }),
    ),
  );
  expect(await repo.findById('other', 'existing')).toMatchObject({
    clinicId: 'other',
  });
  expect(await repo.findById('missing', 'existing')).toBeNull();
});
it('supports read-your-writes while exposing no partial state outside the callback', async () => {
  const repo = store();
  await repo.runExclusive(clinic.clinicId, async (unit) => {
    await unit.insert(appointment());
    expect(await unit.findAppointment('existing')).toEqual(appointment());
    expect(await unit.listAppointments(date)).toHaveLength(1);
    expect(await repo.listByDate(clinic.clinicId, date)).toEqual([]);
  });
  expect(await repo.listByDate(clinic.clinicId, date)).toHaveLength(1);
});
it('rolls back insertion if the second write fails and releases the lock after errors', async () => {
  const repo = store();
  await expect(
    repo.runExclusive(clinic.clinicId, async (unit) => {
      await unit.insert(appointment());
      await unit.replace(appointment({ appointmentId: 'missing' }));
    }),
  ).rejects.toMatchObject({ code: 'AppointmentNotFound' });
  await repo.runExclusive(clinic.clinicId, async (unit) => {
    await unit.insert(appointment());
  });
  expect(await repo.listByDate(clinic.clinicId, date)).toHaveLength(1);
});
it('rejects duplicate IDs without overwriting existing history', async () => {
  const repo = store();
  await repo.runExclusive(clinic.clinicId, async (unit) => {
    await unit.insert(appointment());
  });
  await expect(
    repo.runExclusive(clinic.clinicId, async (unit) => {
      await unit.insert(appointment({ startTime: '09:40', endTime: '10:00' }));
    }),
  ).rejects.toMatchObject({ code: 'InvalidInput' });
  expect(await repo.findById(clinic.clinicId, 'existing')).toEqual(
    appointment(),
  );
});
it('closes the unit of work once the callback returns', async () => {
  const repo = store();
  let captured!: ClinicAppointmentUnitOfWork;
  await repo.runExclusive(clinic.clinicId, async (unit) => {
    captured = unit;
  });
  await expect(captured.insert(appointment())).rejects.toMatchObject({
    code: 'InvalidInput',
  });
});
it('keeps original scheduled if replacement insertion fails', async () => {
  const repo = store();
  await repo.runExclusive(clinic.clinicId, async (unit) => {
    await unit.insert(appointment());
  });
  const service = new AppointmentService(
    repo,
    { now: () => now },
    { next: () => 'existing' },
  );
  await expect(
    service.reschedule({
      clinicId: clinic.clinicId,
      appointmentId: 'existing',
      appointmentDate: date,
      startTime: '09:20',
      createdBy: 'clerk-example',
    }),
  ).rejects.toMatchObject({ code: 'InvalidInput' });
  expect(await repo.findById(clinic.clinicId, 'existing')).toEqual(
    appointment(),
  );
});
