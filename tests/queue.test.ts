import { expect, it } from 'vitest';
import { orderCheckedInQueue } from '../src/queue/order.js';
import { appointment, clinic, date } from './support/fixtures.js';

it('scopes the checked-in queue and orders by arrival, start, then ID without mutation', () => {
  const record = appointment({
    status: 'CheckedIn',
    checkedInAt: '2026-09-14T04:00:00Z',
  });
  const input = [
    { ...record, appointmentId: 'c', startTime: '09:40' },
    { ...record, appointmentId: 'b', startTime: '09:20' },
    { ...record, appointmentId: 'a', startTime: '09:20' },
    {
      ...record,
      appointmentId: 'early',
      checkedInAt: '2026-09-14T03:59:00Z',
      startTime: '09:50',
    },
    appointment(),
    { ...record, clinicId: 'other' },
    { ...record, appointmentDate: '2026-09-15' },
  ];
  const before = [...input];
  expect(
    orderCheckedInQueue(input, clinic.clinicId, date).map(
      (a) => a.appointmentId,
    ),
  ).toEqual(['early', 'a', 'b', 'c']);
  expect(input).toEqual(before);
});
it('rejects checked-in records without valid arrival timestamps', () => {
  expect(() =>
    orderCheckedInQueue(
      [appointment({ status: 'CheckedIn' })],
      clinic.clinicId,
      date,
    ),
  ).toThrowError(expect.objectContaining({ code: 'InvalidSchedule' }));
});
it.each(['2026-09-14T09:00:00', '2026-02-30T04:00:00Z', 'invalid'])(
  'rejects non-UTC or malformed arrival timestamp %s',
  (checkedInAt) => {
    expect(() =>
      orderCheckedInQueue(
        [appointment({ status: 'CheckedIn', checkedInAt })],
        clinic.clinicId,
        date,
      ),
    ).toThrowError(expect.objectContaining({ code: 'InvalidSchedule' }));
  },
);
