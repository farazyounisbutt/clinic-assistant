import { SubscriptionStatus } from '../clinic/models.js';
import type { Clinic } from '../clinic/models.js';

export type Environment = Readonly<Record<string, string | undefined>>;
export interface AppConfig {
  readonly clinic: Clinic;
}

function value(env: Environment, key: string, fallback: string): string {
  const result = (env[key] ?? fallback).trim();
  if (!result) throw new Error(`${key} must not be empty`);
  return result;
}

function integer(
  env: Environment,
  key: string,
  fallback: string,
  minimum: number,
  maximum: number = Number.MAX_SAFE_INTEGER,
): number {
  const raw = value(env, key, fallback);
  const result = Number(raw);
  if (
    !/^\d+$/.test(raw) ||
    !Number.isSafeInteger(result) ||
    result < minimum ||
    result > maximum
  ) {
    throw new Error(
      `${key} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return result;
}

/** Inject process.env on Node, or a string-valued binding map on Workers. */
export function loadConfig(env: Environment): AppConfig {
  const timezone = value(env, 'CLINIC_TIMEZONE', 'Asia/Karachi');
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
  } catch {
    throw new Error('CLINIC_TIMEZONE must be a supported timezone');
  }
  const sameDay = value(env, 'SAME_DAY_BOOKING_ALLOWED', 'true');
  if (sameDay !== 'true' && sameDay !== 'false') {
    throw new Error('SAME_DAY_BOOKING_ALLOWED must be true or false');
  }
  const subscription = value(env, 'SUBSCRIPTION_STATUS', 'active');
  if (
    !Object.values(SubscriptionStatus).some((status) => status === subscription)
  ) {
    throw new Error(
      'SUBSCRIPTION_STATUS must be active, inactive, or suspended',
    );
  }
  return {
    clinic: {
      clinicId: value(env, 'CLINIC_ID', 'demo_clinic'),
      doctorName: value(env, 'DOCTOR_NAME', 'Demo Doctor'),
      specialty: value(env, 'SPECIALTY', 'Specialist'),
      timezone,
      appointmentDurationMinutes: integer(
        env,
        'APPOINTMENT_DURATION_MINUTES',
        '20',
        1,
        1440,
      ),
      bookingHorizonDays: integer(env, 'BOOKING_HORIZON_DAYS', '30', 1),
      ...(env.DAILY_APPOINTMENT_LIMIT === undefined
        ? {}
        : {
            dailyAppointmentLimit: integer(
              env,
              'DAILY_APPOINTMENT_LIMIT',
              '',
              1,
            ),
          }),
      sameDayBookingAllowed: sameDay === 'true',
      subscriptionStatus: subscription as SubscriptionStatus,
    },
  };
}
