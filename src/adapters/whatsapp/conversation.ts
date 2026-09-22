import { dailyCapacity } from '../../scheduling/capacity.js';
import { AppointmentService } from '../../appointments/service.js';
import type { Appointment } from '../../appointments/models.js';
import type { ClinicAppointmentUnitOfWork } from '../../ports/repositories.js';
import type { ClinicRecords } from '../../ports/projection.js';
import type { Clock } from '../../ports/runtime.js';
import { getAvailableSlots } from '../../scheduling/availability.js';
import {
  calendarDay,
  localDateAt,
  resolveLocalInstant,
} from '../../scheduling/time.js';
import { DomainError } from '../../shared/errors.js';
import type { Choice, Incoming, Message } from './models.js';

export const SESSION_MS = 30 * 60_000;
export interface Conversation {
  readonly version: number;
  readonly token: string;
  readonly sender: string;
  readonly lastInteractionAt: number;
  readonly expiresAt: number;
  workflow: 'menu' | 'book' | 'manage' | 'reschedule' | 'lookup';
  step:
    | 'menu'
    | 'date'
    | 'slot'
    | 'name'
    | 'reason'
    | 'confirm'
    | 'appointment'
    | 'manage'
    | 'cancel';
  date: string | null;
  slot: string | null;
  name: string | null;
  reason: string | null;
  appointmentId: string | null;
  patientId: string;
  offset: number;
  prompt: Message;
}
export interface Outcome {
  readonly state: Conversation;
  readonly message: Message;
}

/** Deterministic patient adapter; all mutations use the unchanged appointment service. */
export async function converse(
  previous: Conversation | null,
  input: Incoming,
  records: ClinicRecords,
  unit: ClinicAppointmentUnitOfWork,
  clock: Clock,
): Promise<Outcome> {
  const now = clock.now().getTime();
  const valid = previous && previous.expiresAt > now;
  const patient = records.patients.find(
    (p) =>
      p.clinicId === unit.clinic?.clinicId &&
      p.whatsappNumber === `+${input.sender}`,
  );
  const state: Conversation = {
    workflow: 'menu',
    step: 'menu',
    date: null,
    slot: null,
    name: patient?.name && patient.name.length <= 80 ? patient.name : null,
    reason: null,
    appointmentId: null,
    patientId: patient?.patientId ?? crypto.randomUUID(),
    offset: 0,
    prompt: { type: 'text', body: 'Send menu to begin.' },
    ...(valid ? structuredClone(previous) : {}),
    version: (previous?.version ?? 0) + 1,
    token: crypto.randomUUID(),
    sender: input.sender,
    lastInteractionAt: now,
    expiresAt: now + SESSION_MS,
  };
  const clinic = unit.clinic;
  function show(
    body: string,
    choices: readonly Choice[] = [],
    type: 'buttons' | 'list' = 'buttons',
  ) {
    state.prompt = choices.length
      ? { type, body, choices }
      : { type: 'text', body };
  }
  function menu(prefix = '') {
    state.workflow = 'menu';
    state.step = 'menu';
    state.date = null;
    state.slot = null;
    state.reason = null;
    state.appointmentId = null;
    state.offset = 0;
    show(`${prefix}${prefix ? '\n' : ''}How can we help?`, [
      { id: 'book', title: 'Book Appointment' },
      { id: 'lookup', title: 'My Appointment' },
      { id: 'manage', title: 'Manage Appointment' },
    ]);
  }
  const service = new AppointmentService(
    {
      runExclusive: async (clinicId, fn) => {
        if (clinicId !== clinic?.clinicId)
          throw new DomainError('InvalidInput');
        return fn(unit);
      },
    },
    clock,
    { next: () => crypto.randomUUID() },
  );
  function owned(manage: boolean): Appointment[] {
    if (!clinic) return [];
    return records.appointments
      .filter(
        (a) =>
          a.clinicId === clinic.clinicId &&
          a.whatsappNumber === `+${input.sender}` &&
          (a.status === 'Scheduled' || (!manage && a.status === 'CheckedIn')) &&
          resolveLocalInstant(a.appointmentDate, a.startTime, clinic.timezone) >
            now,
      )
      .sort((a, b) =>
        `${a.appointmentDate}${a.startTime}${a.appointmentId}`.localeCompare(
          `${b.appointmentDate}${b.startTime}${b.appointmentId}`,
        ),
      );
  }
  function selected(): Appointment {
    const appointment = owned(true).find(
      (a) => a.appointmentId === state.appointmentId,
    );
    if (!appointment) throw new DomainError('AppointmentNotFound');
    return appointment;
  }
  async function available(date: string) {
    const slots = getAvailableSlots(
      {
        clinic,
        workingHours: await unit.listWorkingHours(),
        blockedSlots: await unit.listBlockedSlots(date),
        appointments: (await unit.listAppointments(date)).filter(
          (a) =>
            state.workflow !== 'reschedule' ||
            a.appointmentId !== state.appointmentId,
        ),
      },
      date,
      clock.now(),
    );
    return slots.filter(
      (s) =>
        state.workflow !== 'reschedule' ||
        !records.appointments.some(
          (a) =>
            a.appointmentId === state.appointmentId &&
            a.appointmentDate === date &&
            a.startTime === s.startTime,
        ),
    );
  }
  async function dates(prefix = '', offset = 0) {
    if (!clinic) throw new DomainError('ClinicNotFound');
    if (state.workflow === 'reschedule') selected();
    state.step = 'date';
    state.date = null;
    state.slot = null;
    state.offset = offset;
    const today = calendarDay(localDateAt(clock.now(), clinic.timezone));
    const choices: Choice[] = [];
    let day = Math.max(offset, clinic.sameDayBookingAllowed ? 0 : 1);
    const end = Math.min(clinic.bookingHorizonDays, day + 30);
    // Bound each date query even when runtime configuration has a very long horizon.
    for (; day < end && choices.length < 9; day++) {
      const date = new Date((today + day) * 86400000)
        .toISOString()
        .slice(0, 10);
      if ((await available(date)).length)
        choices.push({ id: `date:${date}`, title: date });
    }
    state.offset = day;
    if (day < clinic.bookingHorizonDays)
      choices.push({ id: 'more-dates', title: 'More dates' });
    if (!choices.length)
      return menu(
        'No appointments are available in the current booking window; dates may be fully booked. Please try again later.',
      );
    show(
      `${prefix}${prefix ? '\n' : ''}Choose an available date (${clinic.timezone}).`,
      choices,
      'list',
    );
  }
  async function slots(prefix = '') {
    if (!state.date) return dates(prefix);
    state.step = 'slot';
    const all = await available(state.date);
    if (!all.length)
      return dates(
        dailyCapacity(
          clinic!,
          state.date,
          records.appointments.filter(
            (a) =>
              state.workflow !== 'reschedule' ||
              a.appointmentId !== state.appointmentId,
          ),
        ).remaining === 0
          ? 'That date is fully booked. Please choose another date.'
          : 'That date has no available times. Choose another date.',
      );
    if (state.offset >= all.length) state.offset = 0;
    const choices: Choice[] = all
      .slice(state.offset, state.offset + 9)
      .map((s) => ({ id: `slot:${s.startTime}`, title: s.startTime }));
    if (state.offset + 9 < all.length)
      choices.push({ id: 'more', title: 'More times' });
    show(
      `${prefix}${prefix ? '\n' : ''}Choose a time for ${state.date}. Times are confirmed only when you finish.`,
      choices,
      'list',
    );
  }
  function reason() {
    state.step = 'reason';
    show(
      'Optional: enter a brief administrative note (160 characters maximum), or Skip. Do not send diagnosis, medical history, prescriptions, or identity documents.',
      [{ id: 'skip', title: 'Skip' }],
    );
  }
  function confirm() {
    state.step = 'confirm';
    show(
      `${state.workflow === 'reschedule' ? 'Confirm reschedule' : 'Confirm appointment'}\n${clinic!.doctorName.slice(0, 160)}\n${state.date} at ${state.slot} (${clinic!.timezone})\nName: ${state.name}${state.reason ? `\nNote: ${state.reason}` : ''}`,
      [
        { id: 'confirm', title: 'Confirm' },
        { id: 'change', title: 'Change' },
        { id: 'abort', title: 'Cancel' },
      ],
    );
  }
  function appointments() {
    state.step = 'appointment';
    const all = owned(state.workflow === 'manage');
    if (!all.length) return menu('You have no eligible upcoming appointments.');
    if (state.offset >= all.length) state.offset = 0;
    const choices: Choice[] = all
      .slice(state.offset, state.offset + 9)
      .map((a) => ({
        id: `appointment:${a.appointmentId}`,
        title: `${a.appointmentDate} ${a.startTime}`,
        description: a.status,
      }));
    if (state.offset + 9 < all.length)
      choices.push({ id: 'more', title: 'More appointments' });
    show('Choose one of your upcoming appointments.', choices, 'list');
  }
  const text = input.input.type === 'text' ? input.input.value.trim() : '';
  // Action IDs are bound to one displayed state, not just a workflow step.
  const action =
    input.input.type === 'action' && valid && previous.prompt.type !== 'text'
      ? previous.prompt.choices.find(
          (c) => `${previous.token}:${c.id}` === input.input.value,
        )?.id
      : undefined;
  try {
    if (!clinic) {
      menu(
        'This clinic is not ready for appointments. Please try again later.',
      );
    } else if (/^(hi|hello|menu|restart)$/i.test(text)) menu();
    else if (!valid)
      menu(previous ? 'Your session expired. Please start again.' : '');
    else if (action === 'abort') menu('No changes made.');
    else if (
      state.step === 'menu' &&
      (action === 'book' || action === 'lookup' || action === 'manage')
    ) {
      state.workflow =
        action === 'book' ? 'book' : action === 'lookup' ? 'lookup' : 'manage';
      if (action === 'book') await dates();
      else appointments();
    } else if (state.step === 'date' && action === 'more-dates') {
      await dates('', state.offset);
    } else if (state.step === 'date' && action?.startsWith('date:')) {
      state.date = action.slice(5);
      state.offset = 0;
      await slots();
    } else if (state.step === 'slot' && action === 'more') {
      state.offset += 9;
      await slots();
    } else if (state.step === 'slot' && action?.startsWith('slot:')) {
      state.slot = action.slice(5);
      if (state.workflow === 'reschedule') {
        const original = selected();
        state.name = original.patientName;
        state.reason = original.reason ?? null;
        confirm();
      } else if (state.name) reason();
      else {
        state.step = 'name';
        show(
          'Please enter the patient name (up to 80 characters). Send menu to restart.',
        );
      }
    } else if (state.step === 'name' && text && text.length <= 80) {
      state.name = text;
      reason();
    } else if (
      state.step === 'reason' &&
      (action === 'skip' || (text && text.length <= 160))
    ) {
      state.reason = action === 'skip' ? null : text;
      confirm();
    } else if (state.step === 'confirm' && action === 'change') {
      if (state.workflow === 'reschedule') await dates();
      else {
        show('What would you like to change?', [
          { id: 'change-date', title: 'Date / time' },
          { id: 'change-name', title: 'Patient name' },
          { id: 'abort', title: 'Cancel' },
        ]);
      }
    } else if (state.step === 'confirm' && action === 'change-date')
      await dates();
    else if (state.step === 'confirm' && action === 'change-name') {
      state.step = 'name';
      show(
        'Enter the corrected patient name (up to 80 characters). Send menu to restart.',
      );
    } else if (state.step === 'confirm' && action === 'confirm') {
      let appointment: Appointment;
      if (state.workflow === 'reschedule') {
        selected();
        appointment = await service.reschedule({
          clinicId: clinic.clinicId,
          appointmentId: state.appointmentId!,
          appointmentDate: state.date!,
          startTime: state.slot!,
          createdBy: 'whatsapp-patient',
        });
      } else
        appointment = await service.book({
          clinicId: clinic.clinicId,
          patientId: state.patientId,
          patientName: state.name!,
          whatsappNumber: `+${input.sender}`,
          appointmentDate: state.date!,
          startTime: state.slot!,
          source: 'WhatsApp',
          createdBy: 'whatsapp-patient',
          ...(state.reason ? { reason: state.reason } : {}),
        });
      menu(
        `Appointment confirmed.\nReference: ${appointment.appointmentId}\n${appointment.appointmentDate} at ${appointment.startTime}`,
      );
    } else if (state.step === 'appointment' && action === 'more') {
      state.offset += 9;
      appointments();
    } else if (
      state.step === 'appointment' &&
      action?.startsWith('appointment:')
    ) {
      const a = owned(state.workflow === 'manage').find(
        (a) => a.appointmentId === action.slice(12),
      );
      if (!a) throw new DomainError('AppointmentNotFound');
      state.appointmentId = a.appointmentId;
      const summary = `Reference: ${a.appointmentId}\n${a.appointmentDate} at ${a.startTime}\n${a.status}`;
      if (state.workflow === 'lookup') menu(summary);
      else {
        state.step = 'manage';
        show(summary, [
          { id: 'cancel', title: 'Cancel appointment' },
          { id: 'reschedule', title: 'Reschedule' },
          { id: 'abort', title: 'Back' },
        ]);
      }
    } else if (state.step === 'manage' && action === 'cancel') {
      const a = selected();
      state.step = 'cancel';
      show(`Cancel appointment ${a.appointmentDate} at ${a.startTime}?`, [
        { id: 'confirm-cancel', title: 'Yes, cancel' },
        { id: 'abort', title: 'Keep appointment' },
      ]);
    } else if (state.step === 'cancel' && action === 'confirm-cancel') {
      const a = selected();
      await service.transition({
        clinicId: clinic.clinicId,
        appointmentId: a.appointmentId,
        to: 'Cancelled',
        actor: { id: 'whatsapp-patient', role: 'Patient' },
      });
      menu(`Appointment cancelled.\nReference: ${a.appointmentId}`);
    } else if (state.step === 'manage' && action === 'reschedule') {
      selected();
      state.workflow = 'reschedule';
      await dates();
    } else {
      state.prompt = {
        ...state.prompt,
        body: `Please use the current options${state.step === 'name' || state.step === 'reason' ? ' or enter the requested text' : ''}. Send menu to restart.\n${state.prompt.body.replace(/^Please use[^\n]*\n/, '')}`,
      };
    }
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    if (error.code === 'SubscriptionInactive')
      menu(
        'New bookings and rescheduling are currently unavailable. You can still view or cancel existing appointments.',
      );
    else if (error.code === 'DailyCapacityReached') {
      await dates('That date is fully booked. Please choose another date.');
    } else if (
      [
        'SlotConflict',
        'SlotBlocked',
        'SlotInPast',
        'SlotOffGrid',
        'SlotOutsideWorkingHours',
        'SlotOverlapsBreak',
        'ClinicClosed',
        'InvalidLocalTime',
      ].includes(error.code)
    ) {
      try {
        state.offset = 0;
        await slots('That time is no longer available. Please choose again.');
      } catch {
        menu(
          'Availability changed. Please start again. Existing appointments are unchanged.',
        );
      }
    } else
      menu(
        'That action is no longer available. Please start again. Existing appointments are unchanged.',
      );
  }
  const message: Message =
    state.prompt.type === 'text'
      ? state.prompt
      : {
          ...state.prompt,
          choices: state.prompt.choices.map((c) => ({
            ...c,
            id: `${state.token}:${c.id}`,
          })),
        };
  return { state, message };
}
