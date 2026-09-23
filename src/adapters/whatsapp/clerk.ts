import { normalizeMobileNumber } from '../../patients/mobile.js';
import {
  formatClinicTime,
  formatClinicTimeRange,
} from '../../presentation/time.js';
import type { ClinicOperator } from '../../ports/operators.js';
import type { ClinicAppointmentUnitOfWork } from '../../ports/repositories.js';
import type { ClinicRecords } from '../../ports/projection.js';
import type { Clock } from '../../ports/runtime.js';
import type { Appointment } from '../../appointments/models.js';
import { AppointmentService } from '../../appointments/service.js';
import { BlockTimeService } from '../../scheduling/block-time.js';
import { localDateAt, calendarDay } from '../../scheduling/time.js';
import { orderCheckedInQueue } from '../../queue/order.js';
import { DomainError } from '../../shared/errors.js';
import type { Incoming, Message, Choice } from './models.js';
import { SESSION_MS } from './conversation.js';

type Operation =
  | 'today'
  | 'tomorrow'
  | 'choose-date'
  | 'search'
  | 'walk'
  | 'checkin'
  | 'complete'
  | 'noshow'
  | 'block';
const isReadOperation = (operation: Operation | null) =>
  operation === 'today' ||
  operation === 'tomorrow' ||
  operation === 'choose-date' ||
  operation === 'search';
export interface ClerkConversation {
  readonly kind: 'clerk';
  readonly operatorId: string;
  readonly sender: string;
  readonly version: number;
  readonly token: string;
  readonly expiresAt: number;
  readonly lastInteractionAt: number;
  workflow: 'clerk';
  step:
    | 'menu'
    | 'appointment'
    | 'name'
    | 'slot'
    | 'note'
    | 'confirm'
    | 'after-walk'
    | 'date'
    | 'start'
    | 'end'
    | 'browse-date'
    | 'search'
    | 'mobile';
  operation: Operation | null;
  date: string | null;
  slot: string | null;
  end: string | null;
  name: string | null;
  note: string | null;
  appointmentId: string | null;
  offset: number;
  query: string | null;
  mobile: string | null;
  prompt: Message;
}
export interface ClerkOutcome {
  readonly state: ClerkConversation;
  readonly message: Message;
}
const options: readonly Choice[] = [
  { id: 'today', title: "Today's Appointments" },
  { id: 'tomorrow', title: "Tomorrow's Appointments" },
  { id: 'choose-date', title: 'Choose Date' },
  { id: 'search', title: 'Search Appointment' },
  { id: 'walk', title: 'Add Walk-in' },
  { id: 'checkin', title: 'Check In Patient' },
  { id: 'complete', title: 'Mark Completed' },
  { id: 'noshow', title: 'Mark No Show' },
  { id: 'block', title: 'Block Time' },
];
const statusLabel = (a: Appointment) =>
  a.status === 'CheckedIn'
    ? 'Checked In'
    : a.status === 'NoShow'
      ? 'No Show'
      : a.status;
export async function converseClerk(
  previous: ClerkConversation | null,
  incoming: Incoming,
  records: ClinicRecords,
  unit: ClinicAppointmentUnitOfWork,
  clock: Clock,
  operator: ClinicOperator,
): Promise<ClerkOutcome> {
  if (operator.role !== 'Clerk') throw new DomainError('InvalidInput');
  const now = clock.now();
  const valid =
    previous?.kind === 'clerk' &&
    previous.operatorId === operator.operatorId &&
    previous.sender === incoming.sender &&
    previous.expiresAt > now.getTime();
  const state: ClerkConversation = {
    kind: 'clerk',
    operatorId: operator.operatorId,
    sender: incoming.sender,
    workflow: 'clerk',
    step: 'menu',
    operation: null,
    date: null,
    slot: null,
    end: null,
    name: null,
    note: null,
    appointmentId: null,
    offset: 0,
    query: null,
    mobile: null,
    prompt: { type: 'text', body: 'Clerk menu' },
    ...(valid ? structuredClone(previous) : {}),
    token: crypto.randomUUID(),
    version: (previous?.version ?? 0) + 1,
    expiresAt: now.getTime() + SESSION_MS,
    lastInteractionAt: now.getTime(),
  };
  const show = (
    body: string,
    choices: readonly Choice[] = [],
    type: 'buttons' | 'list' = 'buttons',
  ) => {
    state.prompt = choices.length
      ? { type, body, choices }
      : { type: 'text', body };
  };
  const menu = (prefix = '') => {
    state.step = 'menu';
    state.operation = null;
    state.date = null;
    state.slot = null;
    state.end = null;
    state.name = null;
    state.note = null;
    state.appointmentId = null;
    state.offset = 0;
    state.query = null;
    state.mobile = null;
    show(`${prefix}${prefix ? '\n' : ''}Clerk menu`, options, 'list');
  };
  const finish = (): ClerkOutcome => ({
    state,
    message:
      state.prompt.type === 'text'
        ? state.prompt
        : {
            ...state.prompt,
            choices: state.prompt.choices.map((c) => ({
              ...c,
              id: `${state.token}:${c.id}`,
            })),
          },
  });
  const clinic = unit.clinic;
  if (!clinic || records.clinic?.clinicId !== clinic.clinicId) {
    show('Clinic operations are unavailable.');
    return finish();
  }
  const today = localDateAt(now, clinic.timezone);
  const coordinator = {
    runExclusive: async <T>(
      id: string,
      fn: (u: ClinicAppointmentUnitOfWork) => Promise<T>,
    ) => {
      if (id !== clinic.clinicId) throw new DomainError('InvalidInput');
      return fn(unit);
    },
  };
  const service = new AppointmentService(coordinator, clock, {
    next: () => crypto.randomUUID(),
  });
  const blocks = new BlockTimeService(coordinator, clock, {
    next: () => crypto.randomUUID(),
  });
  const confirm = (body: string) => {
    state.step = 'confirm';
    show(body, [
      { id: 'confirm', title: 'Confirm' },
      { id: 'abort', title: 'Back to menu' },
    ]);
  };
  const page = (body: string, rows: readonly Choice[]) => {
    const selected = rows.slice(state.offset, state.offset + 9);
    if (state.offset + 9 < rows.length)
      selected.push({ id: 'more', title: 'More' });
    show(body, selected, 'list');
  };
  const eligible = async () => {
    const query = state.query ?? '';
    const phoneSearch = /^[+\d\s().-]+$/.test(query);
    const normalizedMobile = normalizeMobileNumber(query);
    const normalize = (value: string) =>
      value.trim().replace(/\s+/g, ' ').toLowerCase();
    const rows =
      state.operation === 'search'
        ? records.appointments.filter(
            (a) =>
              a.clinicId === clinic.clinicId &&
              (phoneSearch
                ? normalizedMobile !== null &&
                  normalizeMobileNumber(a.whatsappNumber) === normalizedMobile
                : normalize(a.patientName).includes(normalize(query))),
          )
        : await service.listAppointments(
            clinic.clinicId,
            isReadOperation(state.operation) ? (state.date ?? today) : today,
          );
    return rows
      .filter(
        (a) =>
          a.clinicId === clinic.clinicId &&
          (isReadOperation(state.operation) ||
            a.status ===
              (state.operation === 'complete' ? 'CheckedIn' : 'Scheduled')),
      )
      .sort((a, b) =>
        `${a.appointmentDate}:${a.startTime}:${a.appointmentId}`.localeCompare(
          `${b.appointmentDate}:${b.startTime}:${b.appointmentId}`,
        ),
      );
  };
  const appointments = async () => {
    const rows = await eligible();
    state.step = 'appointment';
    if (!isReadOperation(state.operation)) state.date = today;
    if (!rows.length) {
      menu(
        state.operation === 'search'
          ? 'No matching appointments.'
          : state.date === today
            ? 'No eligible appointments today.'
            : `No appointments for ${state.date}.`,
      );
      return;
    }
    if (state.offset >= rows.length) state.offset = 0;
    page(
      state.operation === 'search'
        ? `Search results — ${clinic.timezone}`
        : `${state.date === today ? 'Today' : 'Appointments'} (${state.date}) — ${clinic.timezone}`,
      rows.map((a) => ({
        id: `appointment:${a.appointmentId}`,
        title: `${formatClinicTime(a.startTime)} ${a.patientName}`.slice(0, 24),
        description:
          `${state.operation === 'search' ? a.appointmentDate + ' · ' : ''}${statusLabel(a)} · ${a.source} · ${a.appointmentId.slice(0, 8)}`.slice(
            0,
            72,
          ),
      })),
    );
  };
  const slots = async (prefix = '') => {
    state.step = 'slot';
    state.date = today;
    const rows = await service.availability(clinic.clinicId, today);
    if (!rows.length) {
      menu('No available walk-in slots today.');
      return;
    }
    page(
      `${prefix}${prefix ? '\n' : ''}Choose a time for today (${clinic.timezone}).`,
      rows.map((s) => ({
        id: `slot:${s.startTime}`,
        title: `${formatClinicTimeRange(s.startTime, s.endTime)}`,
      })),
    );
  };
  const text =
    incoming.input.type === 'text' ? incoming.input.value.trim() : '';
  const reset = ['menu', 'restart', 'clerk', 'staff', 'hi', 'hello'].includes(
    text.toLowerCase(),
  );
  const action =
    valid && incoming.input.type === 'action' && previous.prompt.type !== 'text'
      ? previous.prompt.choices.find(
          (c) => `${previous.token}:${c.id}` === incoming.input.value,
        )?.id
      : undefined;
  try {
    if (reset || !valid) {
      menu();
      return finish();
    }
    if (action === 'abort') {
      menu();
      return finish();
    }
    if (
      incoming.input.type === 'unsupported' ||
      (incoming.input.type === 'action' && !action)
    ) {
      return finish();
    }
    if (
      state.step === 'menu' &&
      action &&
      options.some((c) => c.id === action)
    ) {
      state.operation = action as Operation;
      state.offset = 0;
      if (action === 'walk') {
        await service.availability(clinic.clinicId, today);
        state.step = 'name';
        state.date = today;
        show('Patient display name (maximum 80 characters).');
      } else if (action === 'block') {
        state.step = 'date';
        show(`Block date: YYYY-MM-DD (${clinic.timezone}).`);
      } else if (action === 'choose-date') {
        state.step = 'browse-date';
        show(`Appointment date: YYYY-MM-DD (${clinic.timezone}).`);
      } else if (action === 'search') {
        state.step = 'search';
        show(
          'Enter a patient name (at least 2 characters) or existing mobile number (03... or international +country code).',
        );
      } else {
        state.date =
          action === 'tomorrow'
            ? new Date((calendarDay(today) + 1) * 86_400_000)
                .toISOString()
                .slice(0, 10)
            : today;
        await appointments();
      }
    } else if (state.step === 'browse-date' && text) {
      try {
        calendarDay(text);
      } catch {
        show(
          `Enter a valid appointment date: YYYY-MM-DD (${clinic.timezone}).`,
        );
        return finish();
      }
      state.date = text;
      state.offset = 0;
      await appointments();
    } else if (state.step === 'search' && incoming.input.type === 'text') {
      const query = text.replace(/\s+/g, ' ').trim();
      const phone = /^[+\d\s().-]+$/.test(query);
      const mobile = normalizeMobileNumber(query);
      if (
        !query ||
        query.length > 80 ||
        (phone ? mobile === null : query.length < 2)
      ) {
        show(
          'Enter a name of 2–80 characters or a full mobile number (03... or international +country code).',
        );
        return finish();
      }
      state.query = phone ? mobile : query;
      state.offset = 0;
      await appointments();
    } else if (state.step === 'appointment' && action === 'more') {
      state.offset += 9;
      await appointments();
    } else if (
      state.step === 'appointment' &&
      action?.startsWith('appointment:')
    ) {
      const a = (await eligible()).find(
        (a) => a.appointmentId === action.slice(12),
      );
      if (!a) throw new DomainError('AppointmentNotFound');
      state.appointmentId = a.appointmentId;
      state.date = a.appointmentDate;
      const summary = `${a.appointmentDate} ${formatClinicTimeRange(a.startTime, a.endTime)} (${clinic.timezone})\n${a.patientName.slice(0, 80)}\nReference: ${a.appointmentId}\n${statusLabel(a)} · ${a.source}`;
      if (isReadOperation(state.operation)) menu(summary);
      else
        confirm(
          `${state.operation === 'checkin' ? 'Check in' : state.operation === 'complete' ? 'Mark completed' : 'Mark no show'}?\n${summary}`,
        );
    } else if (state.step === 'name' && text) {
      if (text.length > 80) {
        show('Use a name of at most 80 characters.');
      } else {
        state.name = text;
        state.step = 'mobile';
        show(
          'Optional patient mobile number: 03... or international +country code. Choose Skip if unavailable.',
          [{ id: 'skip-mobile', title: 'Skip' }],
        );
      }
    } else if (
      state.step === 'mobile' &&
      (incoming.input.type === 'text' || action === 'skip-mobile')
    ) {
      const mobile =
        action === 'skip-mobile' ? null : normalizeMobileNumber(text);
      if (action !== 'skip-mobile' && !mobile) {
        show(
          'Enter a valid mobile number (03... or international +country code), or choose Skip.',
          [{ id: 'skip-mobile', title: 'Skip' }],
        );
      } else {
        state.mobile = mobile;
        state.offset = 0;
        await slots();
      }
    } else if (state.step === 'slot' && action === 'more') {
      state.offset += 9;
      await slots();
    } else if (state.step === 'slot' && action?.startsWith('slot:')) {
      const chosen = action.slice(5);
      const available = await service.availability(clinic.clinicId, today);
      if (!available.some((s) => s.startTime === chosen)) {
        state.offset = 0;
        await slots('That slot is no longer available.');
      } else {
        state.slot = chosen;
        state.step = 'note';
        show(
          'Optional operational note only (160 characters maximum), or Skip.',
          [{ id: 'skip', title: 'Skip' }],
        );
      }
    } else if (state.step === 'date' && text) {
      calendarDay(text);
      state.date = text;
      state.step = 'start';
      show('Start time: HH:mm (24-hour clinic-local time).');
    } else if (state.step === 'start' && text) {
      state.slot = text;
      state.step = 'end';
      show('End time: HH:mm (same local date).');
    } else if (state.step === 'end' && text) {
      state.end = text;
      state.step = 'note';
      show('Optional operational reason (160 characters maximum), or Skip.', [
        { id: 'skip', title: 'Skip' },
      ]);
    } else if (state.step === 'note' && (text || action === 'skip')) {
      if (text.length > 160) {
        show('Use at most 160 characters, or Skip.', [
          { id: 'skip', title: 'Skip' },
        ]);
      } else {
        state.note = action === 'skip' ? null : text;
        confirm(
          `${state.operation === 'walk' ? 'Add walk-in' : 'Block time'}?\n${state.date} ${state.end ? formatClinicTimeRange(state.slot!, state.end) : formatClinicTime(state.slot!)}\n${clinic.timezone}${state.name ? `\n${state.name}` : ''}${state.note ? `\n${state.note}` : ''}`,
        );
      }
    } else if (state.step === 'after-walk' && action === 'check-now') {
      state.operation = 'checkin';
      confirm('Check in this walk-in now?');
    } else if (state.step === 'confirm' && action === 'confirm') {
      if (state.operation === 'walk') {
        if (state.date !== today) throw new DomainError('SlotInPast');
        const a = await service.book({
          clinicId: clinic.clinicId,
          patientId: crypto.randomUUID(),
          patientName: state.name!,
          whatsappNumber: state.mobile ?? '',
          appointmentDate: today,
          startTime: state.slot!,
          source: 'WalkIn',
          createdBy: operator.operatorId,
          ...(state.note ? { reason: state.note } : {}),
        });
        state.name = null;
        state.note = null;
        state.appointmentId = a.appointmentId;
        state.step = 'after-walk';
        show(
          `Walk-in booked: ${formatClinicTimeRange(a.startTime, a.endTime)} (${clinic.timezone})\nReference: ${a.appointmentId}`,
          [
            { id: 'check-now', title: 'Check In Now' },
            { id: 'abort', title: 'Back to menu' },
          ],
        );
      } else if (state.operation === 'block') {
        await blocks.create({
          clinicId: clinic.clinicId,
          date: state.date!,
          startTime: state.slot!,
          endTime: state.end!,
          reason: state.note ?? '',
        });
        menu('Time blocked.');
      } else {
        if (state.date !== today) throw new DomainError('AppointmentNotFound');
        const a = (await eligible()).find(
          (a) => a.appointmentId === state.appointmentId,
        );
        if (!a) throw new DomainError('AppointmentNotFound');
        const to =
          state.operation === 'checkin'
            ? 'CheckedIn'
            : state.operation === 'complete'
              ? 'Completed'
              : 'NoShow';
        await service.transition({
          clinicId: clinic.clinicId,
          appointmentId: a.appointmentId,
          to,
          actor: { id: operator.operatorId, role: 'Clerk' },
        });
        const queue =
          to === 'CheckedIn'
            ? orderCheckedInQueue(
                await unit.listAppointments(today),
                clinic.clinicId,
                today,
              ).findIndex((x) => x.appointmentId === a.appointmentId) + 1
            : null;
        menu(
          `${to === 'CheckedIn' ? 'Checked in' : to === 'Completed' ? 'Completed' : 'Marked no show'}.\nReference: ${a.appointmentId}${queue ? `\nQueue position: ${queue}` : ''}`,
        );
      }
    }
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    if (
      state.operation === 'walk' &&
      ['SlotConflict', 'SlotBlocked', 'SlotInPast', 'SlotOffGrid'].includes(
        error.code,
      )
    ) {
      state.offset = 0;
      try {
        await slots('That slot is no longer available. Please choose again.');
      } catch (e) {
        if (!(e instanceof DomainError)) throw e;
        menu('New reservations are unavailable.');
      }
    } else
      menu(
        error.code === 'DailyCapacityReached'
          ? 'Today is fully booked. No more walk-ins can be reserved.'
          : error.code === 'SubscriptionInactive'
            ? 'New reservations are unavailable.'
            : error.code === 'SlotConflict'
              ? 'That time overlaps an active appointment. Handle the existing appointment separately.'
              : error.code === 'SlotBlocked'
                ? 'That time is already blocked.'
                : 'The operation is no longer valid. Please start again.',
      );
  }
  return finish();
}
