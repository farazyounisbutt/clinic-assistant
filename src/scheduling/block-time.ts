import type { AppointmentWriteCoordinator } from '../ports/repositories.js';
import type { Clock, AppointmentIdGenerator } from '../ports/runtime.js';
import type { BlockedSlot } from './models.js';
import { assertClinicConfiguration } from '../clinic/validation.js';
import {
  calendarDay,
  localDateAt,
  minutes,
  resolveLocalInstant,
} from './time.js';
import { intervalsOverlap } from './availability.js';
import { isActiveAppointmentStatus } from '../appointments/lifecycle.js';
import { DomainError } from '../shared/errors.js';
export interface BlockTimeInput {
  readonly clinicId: string;
  readonly date: string;
  readonly startTime: string;
  readonly endTime: string;
  readonly reason: string;
}
/** Operational configuration mutation: subscription status does not restrict blocking. */
export class BlockTimeService {
  constructor(
    private readonly coordinator: AppointmentWriteCoordinator,
    private readonly clock: Clock,
    private readonly ids: AppointmentIdGenerator,
  ) {}
  create(input: BlockTimeInput): Promise<BlockedSlot> {
    return this.coordinator.runExclusive(input.clinicId, async (unit) => {
      assertClinicConfiguration(unit.clinic);
      const clinic = unit.clinic;
      if (clinic.clinicId !== input.clinicId || !unit.insertBlockedSlot)
        throw new DomainError('InvalidInput');
      const now = this.clock.now();
      const day = calendarDay(input.date);
      const today = calendarDay(localDateAt(now, clinic.timezone));
      if (day < today || day - today >= clinic.bookingHorizonDays)
        throw new DomainError('DateOutsideBookingHorizon');
      if (
        minutes(input.startTime) >= minutes(input.endTime) ||
        typeof input.reason !== 'string' ||
        input.reason.length > 160
      )
        throw new DomainError('InvalidSchedule');
      const start = resolveLocalInstant(
        input.date,
        input.startTime,
        clinic.timezone,
      );
      const end = resolveLocalInstant(
        input.date,
        input.endTime,
        clinic.timezone,
      );
      if (start <= now.getTime()) throw new DomainError('SlotInPast');
      if (
        end - start !==
        (minutes(input.endTime) - minutes(input.startTime)) * 60_000
      )
        throw new DomainError('InvalidLocalTime');
      const weekday = ((new Date(day * 86_400_000).getUTCDay() + 6) % 7) + 1;
      const hours = (await unit.listWorkingHours()).filter(
        (h) =>
          h.clinicId === input.clinicId && h.active && h.dayOfWeek === weekday,
      );
      if (
        !hours.some(
          (h) => h.startTime <= input.startTime && h.endTime >= input.endTime,
        ) ||
        hours.some((h) => h.breaks?.some((b) => intervalsOverlap(b, input)))
      )
        throw new DomainError('SlotOutsideWorkingHours');
      if (
        (await unit.listAppointments(input.date)).some(
          (a) =>
            a.clinicId === input.clinicId &&
            isActiveAppointmentStatus(a.status) &&
            intervalsOverlap(a, input),
        )
      )
        throw new DomainError('SlotConflict');
      if (
        (await unit.listBlockedSlots(input.date)).some((b) =>
          intervalsOverlap(b, input),
        )
      )
        throw new DomainError('SlotBlocked');
      const block = { ...input, id: this.ids.next() };
      await unit.insertBlockedSlot(block);
      return block;
    });
  }
}
