import { describe, expect, it } from 'vitest';
import { cleanConfiguration } from '../../src/adapters/cloudflare/configuration.js';
import worker from '../../src/adapters/cloudflare/worker.js';
import { clinic, hours } from '../support/fixtures.js';
import {
  projectionSnapshot,
  SHEET_COLUMNS,
} from '../../src/projection/sheets.js';
import type { ClinicRecords } from '../../src/ports/projection.js';

const configuration = { clinic, workingHours: [hours], blockedSlots: [] };
describe('configuration boundary', () => {
  it.each([
    { ...configuration, clinic: { ...clinic, clinicId: 'other' } },
    { ...configuration, workingHours: [{ ...hours, clinicId: 'other' }] },
    {
      ...configuration,
      workingHours: [{ ...hours, endTime: hours.startTime }],
    },
    {
      ...configuration,
      workingHours: [
        { ...hours, breaks: [{ startTime: '08:00', endTime: '08:10' }] },
      ],
    },
    { ...configuration, workingHours: [hours, hours] },
    {
      ...configuration,
      workingHours: [hours, { ...hours, startTime: '09:10' }],
    },
    {
      ...configuration,
      blockedSlots: [
        {
          id: 'block',
          clinicId: 'other',
          date: '2030-09-16',
          startTime: '09:00',
          endTime: '09:20',
          reason: 'Unavailable',
        },
      ],
    },
  ])('rejects invalid or cross-clinic configuration', (input) => {
    expect(() => cleanConfiguration(input, clinic.clinicId)).toThrow();
  });
  it('strips unexpected configuration properties and preserves inactive periods', () => {
    const clean = cleanConfiguration(
      {
        ...configuration,
        clinic: Object.assign({}, clinic, { extra: 'discard' }),
        workingHours: [{ ...hours, active: false }],
      },
      clinic.clinicId,
    );
    expect(clean.clinic).not.toHaveProperty('extra');
    expect(clean.workingHours[0]!.active).toBe(false);
  });
  it('exposes no unauthenticated HTTP endpoint', () => {
    expect(worker.fetch().status).toBe(404);
  });
});

describe('projection schema v1', () => {
  const empty: ClinicRecords = {
    clinic: null,
    workingHours: [],
    blockedSlots: [],
    appointments: [],
    patients: [],
    activity: [],
  };
  it('uses exact ordered headers, stable keys, and raw values', () => {
    const snapshot = projectionSnapshot(clinic.clinicId, 7, {
      ...empty,
      clinic,
      workingHours: [hours],
      blockedSlots: [
        {
          id: 'block',
          clinicId: clinic.clinicId,
          date: '2030-09-16',
          startTime: '09:00',
          endTime: '09:20',
          reason: '=synthetic-formula-like-label',
        },
      ],
    });
    for (const name of Object.keys(
      SHEET_COLUMNS,
    ) as (keyof typeof SHEET_COLUMNS)[]) {
      for (const row of snapshot.sheets[name])
        expect(row.cells).toHaveLength(SHEET_COLUMNS[name].length);
    }
    expect(snapshot.sheets.Clinic_Settings[0]!.cells).toEqual([
      clinic.clinicId,
      7,
      clinic.clinicId,
      clinic.doctorName,
      clinic.specialty,
      clinic.timezone,
      20,
      30,
      true,
      'active',
    ]);
    expect(snapshot.sheets.Working_Hours[0]!.key).toBe('1:09:00:10:00');
    expect(snapshot.sheets.Blocked_Slots[0]!.cells.at(-1)).toBe(
      '=synthetic-formula-like-label',
    );
    expect(
      projectionSnapshot(clinic.clinicId, 8, empty).sheets.Clinic_Settings,
    ).toEqual([]);
  });
});
