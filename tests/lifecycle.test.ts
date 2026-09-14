import { describe, expect, it } from 'vitest';
import {
  AppointmentStatus,
  assertAppointmentStatusTransition,
  canTransitionAppointmentStatus,
  isActiveAppointmentStatus,
} from '../src/index.js';

const validEdges = new Set([
  'Scheduled->CheckedIn',
  'CheckedIn->Completed',
  'Scheduled->NoShow',
  'Scheduled->Cancelled',
  'Scheduled->Rescheduled',
]);

describe('appointment lifecycle', () => {
  for (const from of Object.values(AppointmentStatus)) {
    for (const to of Object.values(AppointmentStatus)) {
      it(`${from} -> ${to}`, () => {
        const allowed = validEdges.has(`${from}->${to}`);
        expect(canTransitionAppointmentStatus(from, to)).toBe(allowed);
        if (allowed)
          expect(() =>
            assertAppointmentStatusTransition(from, to),
          ).not.toThrow();
        else
          expect(() => assertAppointmentStatusTransition(from, to)).toThrow(
            'Invalid appointment status transition',
          );
      });
    }
  }
  it('reserves time only for scheduled and checked-in appointments', () => {
    expect(
      Object.values(AppointmentStatus).filter(isActiveAppointmentStatus),
    ).toEqual(['Scheduled', 'CheckedIn']);
  });
});
