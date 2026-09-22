import { expect, it } from 'vitest';
import { developmentEveningHours } from '../src/config/development.js';
import { clinic, hours } from './support/fixtures.js';
const config = {
  clinic: {
    ...clinic,
    clinicId: 'integration_test_clinic',
    dailyAppointmentLimit: 7,
  },
  workingHours: ([1, 2, 3, 4, 5, 6, 7] as const).map((dayOfWeek) => ({
    ...hours,
    clinicId: 'integration_test_clinic',
    dayOfWeek,
    endTime: '18:00',
    breaks: [{ startTime: '12:00', endTime: '12:20' }],
  })),
  blockedSlots: [
    {
      id: 'test-block',
      clinicId: 'integration_test_clinic',
      date: '2030-09-16',
      startTime: '10:00',
      endTime: '10:20',
      reason: 'Synthetic',
    },
  ],
};
it('extends only development periods, preserving configuration, breaks, blocks and inputs', () => {
  const before = JSON.parse(JSON.stringify(config)) as typeof config;
  const next = developmentEveningHours(config);
  expect(next.clinic).toEqual(config.clinic);
  expect(next.blockedSlots).toEqual(config.blockedSlots);
  expect(
    next.workingHours.every(
      (h) => h.startTime === '09:00' && h.endTime === '21:00',
    ),
  ).toBe(true);
  expect(next.workingHours[0]!.breaks).toEqual(config.workingHours[0]!.breaks);
  expect(developmentEveningHours(next)).toEqual(next);
  expect(config).toEqual(before);
});
it('refuses production clinics, other timezones and unfamiliar schedules', () => {
  for (const input of [
    { ...config, clinic },
    { ...config, clinic: { ...config.clinic, timezone: 'UTC' } },
    { ...config, workingHours: [] },
    {
      ...config,
      workingHours: config.workingHours.map((h) => ({
        ...h,
        startTime: '10:00',
      })),
    },
  ])
    expect(() => developmentEveningHours(input)).toThrow();
});
