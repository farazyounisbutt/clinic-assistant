import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/index.js';

describe('configuration', () => {
  it('provides the neutral demo defaults without inventing working hours', () => {
    expect(loadConfig({})).toEqual({
      clinic: {
        clinicId: 'demo_clinic',
        doctorName: 'Demo Doctor',
        specialty: 'Specialist',
        timezone: 'Asia/Karachi',
        appointmentDurationMinutes: 20,
        bookingHorizonDays: 30,
        sameDayBookingAllowed: true,
        subscriptionStatus: 'active',
      },
    });
  });
  it('accepts explicit overrides and parses false correctly', () => {
    expect(
      loadConfig({
        CLINIC_ID: 'example',
        DOCTOR_NAME: 'Example Doctor',
        SPECIALTY: 'Example Specialty',
        CLINIC_TIMEZONE: 'UTC',
        APPOINTMENT_DURATION_MINUTES: '15',
        BOOKING_HORIZON_DAYS: '0',
        SAME_DAY_BOOKING_ALLOWED: 'false',
        SUBSCRIPTION_STATUS: 'suspended',
      }).clinic,
    ).toEqual({
      clinicId: 'example',
      doctorName: 'Example Doctor',
      specialty: 'Example Specialty',
      timezone: 'UTC',
      appointmentDurationMinutes: 15,
      bookingHorizonDays: 0,
      sameDayBookingAllowed: false,
      subscriptionStatus: 'suspended',
    });
  });
  it.each([
    ['CLINIC_ID', ' '],
    ['DOCTOR_NAME', ''],
    ['SPECIALTY', ''],
    ['CLINIC_TIMEZONE', 'invalid/timezone'],
    ['APPOINTMENT_DURATION_MINUTES', '0'],
    ['APPOINTMENT_DURATION_MINUTES', '1.5'],
    ['APPOINTMENT_DURATION_MINUTES', 'NaN'],
    ['APPOINTMENT_DURATION_MINUTES', '9007199254740992'],
    ['BOOKING_HORIZON_DAYS', '-1'],
    ['BOOKING_HORIZON_DAYS', '30days'],
    ['BOOKING_HORIZON_DAYS', ''],
    ['SAME_DAY_BOOKING_ALLOWED', 'yes'],
    ['SUBSCRIPTION_STATUS', 'paid'],
  ])('rejects invalid %s = %s', (key, value) => {
    expect(() => loadConfig({ [key]: value })).toThrow(key);
  });
});
