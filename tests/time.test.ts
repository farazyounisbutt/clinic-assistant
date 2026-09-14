import { expect, it } from 'vitest';
import { localDateAt, resolveLocalInstant } from '../src/scheduling/time.js';

it('resolves Karachi wall time without the machine timezone', () => {
  expect(resolveLocalInstant('2026-09-14', '09:00', 'Asia/Karachi')).toBe(
    Date.parse('2026-09-14T04:00:00Z'),
  );
  expect(
    localDateAt(new Date('2026-01-01T01:00:00Z'), 'America/New_York'),
  ).toBe('2025-12-31');
});
it.each([
  ['2026-03-08', '02:30'],
  ['2026-11-01', '01:30'],
])('rejects nonexistent or ambiguous DST wall time %s %s', (date, time) => {
  expect(() =>
    resolveLocalInstant(date, time, 'America/New_York'),
  ).toThrowError(expect.objectContaining({ code: 'InvalidLocalTime' }));
});
it('resolves normal times on both sides of a DST change', () => {
  expect(resolveLocalInstant('2026-03-08', '01:30', 'America/New_York')).toBe(
    Date.parse('2026-03-08T06:30:00Z'),
  );
  expect(resolveLocalInstant('2026-03-08', '03:30', 'America/New_York')).toBe(
    Date.parse('2026-03-08T07:30:00Z'),
  );
});
