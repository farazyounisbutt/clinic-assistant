import { expect, it } from 'vitest';
import { normalizeMobileNumber } from '../src/patients/mobile.js';

it.each([
  '03001234567',
  '0300 1234567',
  '+92 300 1234567',
  '923001234567',
  '+92 (300) 123-4567',
])('normalizes synthetic Pakistani mobile input %s', (value) => {
  expect(normalizeMobileNumber(value)).toBe('+923001234567');
});
it('retains valid international contacts', () => {
  expect(normalizeMobileNumber('+1 (202) 555-0123')).toBe('+12025550123');
});
it.each([
  undefined,
  null,
  '',
  '   ',
  '0300123',
  '+9203001234567',
  '+9230012345678',
  '+92abc3001234567',
  '++923001234567',
  '03-abc',
  '+03001234567',
  '5550123',
  '1234567890123456',
])('rejects missing or malformed contact %s', (value) =>
  expect(normalizeMobileNumber(value)).toBeNull(),
);
