import { expect, it } from 'vitest';
import {
  assertSlotAvailable,
  getAvailableSlots,
} from '../src/scheduling/availability.js';
import {
  appointment,
  clinic,
  date,
  hours,
  now,
  snapshot,
} from './support/fixtures.js';

it.each([
  [{ workingHours: [] }, 'ClinicClosed'],
  [
    {
      workingHours: [
        { ...hours, breaks: [{ startTime: '09:15', endTime: '09:25' }] },
      ],
    },
    'SlotOverlapsBreak',
  ],
  [
    {
      blockedSlots: [
        {
          clinicId: clinic.clinicId,
          id: 'block',
          date,
          startTime: '09:15',
          endTime: '09:25',
          reason: 'Unavailable',
        },
      ],
    },
    'SlotBlocked',
  ],
  [
    { appointments: [appointment({ startTime: '09:15', endTime: '09:35' })] },
    'SlotConflict',
  ],
] as const)(
  'returns a specific error from authoritative booking validation',
  (overrides, code) => {
    expect(() =>
      assertSlotAvailable(snapshot(overrides), date, '09:00', now),
    ).toThrowError(expect.objectContaining({ code }));
  },
);
it.each([
  { bookingHorizonDays: 0 },
  { bookingHorizonDays: -1 },
  { bookingHorizonDays: 1.5 },
  { timezone: 'invalid/timezone' },
  { clinicId: ' ' },
])('rejects invalid stored clinic configuration %j', (overrides) => {
  expect(() =>
    getAvailableSlots(
      snapshot({ clinic: { ...clinic, ...overrides } }),
      date,
      now,
    ),
  ).toThrowError(
    expect.objectContaining({ code: 'InvalidClinicConfiguration' }),
  );
});
it.each([
  { dayOfWeek: 8 as never },
  { startTime: 'not-time' },
  { breaks: [{ startTime: '08:00', endTime: '09:10' }] },
  { breaks: [{ startTime: '09:50', endTime: '10:10' }] },
])('rejects malformed stored hours %j', (overrides) => {
  expect(() =>
    getAvailableSlots(
      snapshot({ workingHours: [{ ...hours, ...overrides }] }),
      date,
      now,
    ),
  ).toThrowError(expect.objectContaining({ code: 'InvalidSchedule' }));
});
it('counts calendar dates over a leap day and year boundary', () => {
  const allDays = [1, 2, 3, 4, 5, 6, 7].map((dayOfWeek) => ({
    ...hours,
    dayOfWeek: dayOfWeek as typeof hours.dayOfWeek,
  }));
  const s = snapshot({ workingHours: allDays });
  expect(
    getAvailableSlots(s, '2028-03-01', new Date('2028-02-01T03:00:00Z')),
  ).toHaveLength(3);
  expect(() =>
    getAvailableSlots(s, '2028-03-02', new Date('2028-02-01T03:00:00Z')),
  ).toThrowError(
    expect.objectContaining({ code: 'DateOutsideBookingHorizon' }),
  );
  expect(
    getAvailableSlots(s, '2027-01-13', new Date('2026-12-15T03:00:00Z')),
  ).toHaveLength(3);
});
it('still includes tomorrow but not day 30 when same-day is disabled', () => {
  const s = snapshot({
    clinic: { ...clinic, sameDayBookingAllowed: false },
    workingHours: [
      { ...hours, dayOfWeek: 2 },
      { ...hours, dayOfWeek: 3 },
    ],
  });
  expect(getAvailableSlots(s, '2026-09-15', now)).toHaveLength(3);
  expect(() => getAvailableSlots(s, '2026-10-14', now)).toThrowError(
    expect.objectContaining({ code: 'DateOutsideBookingHorizon' }),
  );
});
it('does not assume weekends are closed', () => {
  expect(
    getAvailableSlots(
      snapshot({ workingHours: [{ ...hours, dayOfWeek: 7 }] }),
      '2026-09-20',
      now,
    ),
  ).toHaveLength(3);
});
it('counts the horizon across DST by local calendar dates', () => {
  const s = snapshot({
    clinic: { ...clinic, timezone: 'America/New_York' },
    workingHours: [{ ...hours, dayOfWeek: 2 }],
  });
  expect(
    getAvailableSlots(s, '2026-03-31', new Date('2026-03-02T13:00:00Z')),
  ).toHaveLength(3);
  expect(() =>
    getAvailableSlots(s, '2026-04-01', new Date('2026-03-02T13:00:00Z')),
  ).toThrowError(
    expect.objectContaining({ code: 'DateOutsideBookingHorizon' }),
  );
});
it('omits DST gaps and intervals whose elapsed duration changes', () => {
  const s = snapshot({
    clinic: {
      ...clinic,
      timezone: 'America/New_York',
      appointmentDurationMinutes: 60,
    },
    workingHours: [
      { ...hours, dayOfWeek: 7, startTime: '01:30', endTime: '04:30' },
    ],
  });
  expect(
    getAvailableSlots(s, '2026-03-08', new Date('2026-03-07T12:00:00Z')),
  ).toEqual([{ startTime: '03:30', endTime: '04:30' }]);
  expect(() =>
    assertSlotAvailable(
      {
        ...s,
        clinic: {
          ...clinic,
          timezone: 'America/New_York',
          appointmentDurationMinutes: 120,
        },
      },
      '2026-03-08',
      '01:30',
      new Date('2026-03-07T12:00:00Z'),
    ),
  ).toThrowError(expect.objectContaining({ code: 'InvalidLocalTime' }));
});
it('rejects a broken clock', () => {
  expect(() => getAvailableSlots(snapshot(), date, new Date(NaN))).toThrowError(
    expect.objectContaining({ code: 'InvalidInput' }),
  );
});
it('fails closed for unknown persisted appointment statuses', () => {
  expect(() =>
    getAvailableSlots(
      snapshot({ appointments: [appointment({ status: 'unknown' as never })] }),
      date,
      now,
    ),
  ).toThrowError(expect.objectContaining({ code: 'InvalidSchedule' }));
});
