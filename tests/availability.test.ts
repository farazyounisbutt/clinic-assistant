import { describe, expect, it } from 'vitest';
import {
  assertSlotAvailable,
  getAvailableSlots,
} from '../src/scheduling/availability.js';
import { DomainError } from '../src/shared/errors.js';
import {
  appointment,
  clinic,
  date,
  hours,
  now,
  snapshot,
} from './support/fixtures.js';

describe('availability', () => {
  it('generates full-duration slots including one ending exactly at closing', () => {
    expect(getAvailableSlots(snapshot(), date, now)).toEqual([
      { startTime: '09:00', endTime: '09:20' },
      { startTime: '09:20', endTime: '09:40' },
      { startTime: '09:40', endTime: '10:00' },
    ]);
  });
  it.each([
    [15, 4],
    [30, 2],
    [25, 2],
    [90, 0],
  ])('duration %i yields %i slots', (duration, count) => {
    expect(
      getAvailableSlots(
        snapshot({
          clinic: { ...clinic, appointmentDurationMinutes: duration },
        }),
        date,
        now,
      ),
    ).toHaveLength(count);
  });
  it('supports multiple periods, sorts and deduplicates overlapping configurations', () => {
    const periods = [
      { ...hours, startTime: '14:00', endTime: '14:40' },
      hours,
      hours,
    ];
    expect(
      getAvailableSlots(snapshot({ workingHours: periods }), date, now).map(
        (s) => s.startTime,
      ),
    ).toEqual(['09:00', '09:20', '09:40', '14:00', '14:20']);
  });
  it.each([
    ['09:20', '09:40', ['09:00', '09:40']],
    ['09:15', '09:25', ['09:40']],
    ['08:50', '09:01', ['09:20', '09:40']],
  ])('excludes break overlap %s–%s', (startTime, endTime, expected) => {
    // Breaks must be within their own working period; use a larger period for the boundary case.
    const period = {
      ...hours,
      startTime: startTime === '08:50' ? '08:40' : '09:00',
      breaks: [{ startTime, endTime }],
    };
    expect(
      getAvailableSlots(snapshot({ workingHours: [period] }), date, now).map(
        (s) => s.startTime,
      ),
    ).toEqual(expected);
  });
  it.each([
    ['09:20', '09:40', ['09:00', '09:40']],
    ['09:15', '09:25', ['09:40']],
  ])(
    'excludes blocked interval overlap %s–%s',
    (startTime, endTime, expected) => {
      const blockedSlots = [
        {
          id: 'block',
          clinicId: clinic.clinicId,
          date,
          startTime,
          endTime,
          reason: 'Unavailable',
        },
      ];
      expect(
        getAvailableSlots(snapshot({ blockedSlots }), date, now).map(
          (s) => s.startTime,
        ),
      ).toEqual(expected);
    },
  );
  it.each(['Scheduled', 'CheckedIn'] as const)(
    'blocks overlapping %s appointments with different starts',
    (status) => {
      expect(
        getAvailableSlots(
          snapshot({
            appointments: [
              appointment({ status, startTime: '09:10', endTime: '09:30' }),
            ],
          }),
          date,
          now,
        ),
      ).toEqual([{ startTime: '09:40', endTime: '10:00' }]);
    },
  );
  it.each(['Cancelled', 'Rescheduled', 'NoShow'] as const)(
    '%s does not block a future slot',
    (status) => {
      expect(
        getAvailableSlots(
          snapshot({ appointments: [appointment({ status })] }),
          date,
          now,
        ),
      ).toHaveLength(3);
    },
  );
  it('does not offer a completed historical slot even though its status is nonblocking', () => {
    const later = new Date('2026-09-14T04:20:00Z');
    expect(
      getAvailableSlots(
        snapshot({
          appointments: [
            appointment({
              status: 'Completed',
              completedAt: later.toISOString(),
            }),
          ],
        }),
        date,
        later,
      ),
    ).toEqual([{ startTime: '09:40', endTime: '10:00' }]);
  });
  it('allows reuse of a future grid slot after the appointment was completed early', () => {
    expect(
      getAvailableSlots(
        snapshot({ appointments: [appointment({ status: 'Completed' })] }),
        date,
        now,
      ),
    ).toHaveLength(3);
  });
  it('ignores other dates and clinics', () => {
    expect(
      getAvailableSlots(
        snapshot({
          appointments: [
            appointment({ clinicId: 'other' }),
            appointment({ appointmentDate: '2026-09-15' }),
          ],
        }),
        date,
        now,
      ),
    ).toHaveLength(3);
  });
  it('uses the clinic-local date even when UTC is on the previous date', () => {
    expect(
      getAvailableSlots(snapshot(), date, new Date('2026-09-13T20:00:00Z')),
    ).toHaveLength(3);
  });
  it.each([
    { workingHours: [] },
    { workingHours: [{ ...hours, active: false }] },
    { workingHours: [{ ...hours, dayOfWeek: 2 as const }] },
  ])('returns no slots on a closed day', ({ workingHours }) => {
    expect(getAvailableSlots(snapshot({ workingHours }), date, now)).toEqual(
      [],
    );
  });
  it('never spans a gap between working periods', () => {
    expect(() =>
      assertSlotAvailable(
        snapshot({
          workingHours: [
            { ...hours, endTime: '09:10' },
            { ...hours, startTime: '09:15' },
          ],
        }),
        date,
        '09:00',
        now,
      ),
    ).toThrowError(
      expect.objectContaining({ code: 'SlotOutsideWorkingHours' }),
    );
  });
  it('rejects minute-aligned starts off the generated slot grid', () => {
    expect(() =>
      assertSlotAvailable(snapshot(), date, '09:05', now),
    ).toThrowError(expect.objectContaining({ code: 'SlotOffGrid' }));
  });
  it.each([
    ['09:41', 'SlotOutsideWorkingHours'],
    ['08:59', 'SlotOutsideWorkingHours'],
    ['25:00', 'InvalidInput'],
    ['9:00', 'InvalidInput'],
  ])('rejects start %s with %s', (start, code) => {
    expect(() =>
      assertSlotAvailable(snapshot(), date, start, now),
    ).toThrowError(expect.objectContaining({ code }));
  });
  it.each(['09:00', '09:20'])(
    'requires a strictly future start: %s',
    (start) => {
      expect(() =>
        assertSlotAvailable(
          snapshot(),
          date,
          start,
          new Date('2026-09-14T04:20:00Z'),
        ),
      ).toThrowError(expect.objectContaining({ code: 'SlotInPast' }));
    },
  );
  it('accepts a start one second in the future', () => {
    expect(
      assertSlotAvailable(
        snapshot(),
        date,
        '09:20',
        new Date('2026-09-14T04:19:59Z'),
      ).startTime,
    ).toBe('09:20');
  });
  it('includes day 29 and excludes day 30 without extending for disabled same-day bookings', () => {
    const s = snapshot({
      workingHours: [
        { ...hours, dayOfWeek: 2 },
        { ...hours, dayOfWeek: 3 },
      ],
    });
    expect(getAvailableSlots(s, '2026-10-13', now)).toHaveLength(3);
    expect(() => getAvailableSlots(s, '2026-10-14', now)).toThrowError(
      expect.objectContaining({ code: 'DateOutsideBookingHorizon' }),
    );
    expect(() =>
      getAvailableSlots(
        { ...s, clinic: { ...clinic, sameDayBookingAllowed: false } },
        date,
        now,
      ),
    ).toThrowError(expect.objectContaining({ code: 'SameDayBookingDisabled' }));
  });
  it.each(['2026-09-13', '2026-10-14'])(
    'rejects date outside horizon: %s',
    (value) => {
      expect(() => getAvailableSlots(snapshot(), value, now)).toThrowError(
        expect.objectContaining({ code: 'DateOutsideBookingHorizon' }),
      );
    },
  );
  it.each(['2026-02-30', '2026-9-14', 'nonsense'])(
    'rejects malformed date %s',
    (value) => {
      expect(() => getAvailableSlots(snapshot(), value, now)).toThrowError(
        expect.objectContaining({ code: 'InvalidInput' }),
      );
    },
  );
  it.each([0, -1, 1.5, NaN, 1441])(
    'rejects invalid duration %s',
    (appointmentDurationMinutes) => {
      expect(() =>
        getAvailableSlots(
          snapshot({ clinic: { ...clinic, appointmentDurationMinutes } }),
          date,
          now,
        ),
      ).toThrowError(
        expect.objectContaining({ code: 'InvalidClinicConfiguration' }),
      );
    },
  );
  it('returns a typed error for missing clinic', () => {
    expect(() =>
      getAvailableSlots(snapshot({ clinic: null }), date, now),
    ).toThrowError(DomainError);
  });
  it.each(['inactive', 'suspended'] as const)(
    'rejects %s subscription',
    (subscriptionStatus) => {
      expect(() =>
        getAvailableSlots(
          snapshot({ clinic: { ...clinic, subscriptionStatus } }),
          date,
          now,
        ),
      ).toThrowError(expect.objectContaining({ code: 'SubscriptionInactive' }));
    },
  );
  it('rejects malformed working periods', () => {
    expect(() =>
      getAvailableSlots(
        snapshot({ workingHours: [{ ...hours, endTime: '08:00' }] }),
        date,
        now,
      ),
    ).toThrowError(expect.objectContaining({ code: 'InvalidSchedule' }));
  });
});
