import { expect, it } from 'vitest';
import {
  formatClinicTime,
  formatClinicTimeRange,
} from '../src/presentation/time.js';

it.each([
  ['00:00', '12:00 AM'],
  ['00:05', '12:05 AM'],
  ['09:00', '9:00 AM'],
  ['11:59', '11:59 AM'],
  ['12:00', '12:00 PM'],
  ['12:05', '12:05 PM'],
  ['16:20', '4:20 PM'],
  ['23:59', '11:59 PM'],
])(
  'formats clinic-local %s as %s without timezone conversion',
  (input, expected) => {
    expect(formatClinicTime(input)).toBe(expected);
  },
);
it.each([
  ['11:40', '12:00', '11:40 AM–12:00 PM'],
  ['00:00', '00:20', '12:00 AM–12:20 AM'],
  ['12:00', '12:20', '12:00 PM–12:20 PM'],
  ['23:40', '00:00', '11:40 PM–12:00 AM'],
])('formats range %s to %s', (start, end, expected) => {
  expect(formatClinicTimeRange(start, end)).toBe(expected);
});
it.each(['10', '24:00', '12:60', '9:00', 'invalid'])(
  'rejects malformed internal time %s',
  (time) => {
    expect(() => formatClinicTime(time)).toThrow();
  },
);
