import type { ClinicOperator } from '../../ports/operators.js';
import type { ClinicAppointmentUnitOfWork } from '../../ports/repositories.js';
import type { Clock } from '../../ports/runtime.js';
import type { Appointment } from '../../appointments/models.js';
import { localDateAt } from '../../scheduling/time.js';
import { orderCheckedInQueue } from '../../queue/order.js';
import {
  formatClinicTime,
  formatClinicTimeRange,
} from '../../presentation/time.js';
import { DomainError } from '../../shared/errors.js';
import type { Incoming, Message, Choice } from './models.js';
import { SESSION_MS } from './conversation.js';

export interface DoctorConversation {
  readonly kind: 'doctor';
  readonly workflow: 'doctor';
  readonly operatorId: string;
  readonly sender: string;
  readonly token: string;
  readonly version: number;
  readonly expiresAt: number;
  readonly lastInteractionAt: number;
  step: 'menu' | 'list';
  view: 'today' | 'queue' | null;
  offset: number;
  prompt: Message;
}
export interface DoctorOutcome {
  readonly state: DoctorConversation;
  readonly message: Message;
}
const menuChoices: readonly Choice[] = [
  { id: 'today', title: "Today's Appointments" },
  { id: 'queue', title: 'Waiting Queue' },
  { id: 'summary', title: 'Daily Summary' },
];
/** The Doctor flow receives only read capabilities, never a mutation unit. */
export async function converseDoctor(
  previous: DoctorConversation | null,
  incoming: Incoming,
  unit: Pick<ClinicAppointmentUnitOfWork, 'clinic' | 'listAppointments'>,
  clock: Clock,
  operator: ClinicOperator,
): Promise<DoctorOutcome> {
  if (operator.role !== 'Doctor') throw new DomainError('InvalidInput');
  const now = clock.now();
  const valid =
    previous?.kind === 'doctor' &&
    previous.sender === incoming.sender &&
    previous.operatorId === operator.operatorId &&
    previous.expiresAt > now.getTime();
  const state: DoctorConversation = {
    kind: 'doctor',
    workflow: 'doctor',
    operatorId: operator.operatorId,
    sender: incoming.sender,
    step: 'menu',
    view: null,
    offset: 0,
    prompt: { type: 'text', body: 'Doctor menu' },
    ...(valid ? structuredClone(previous) : {}),
    token: crypto.randomUUID(),
    version: (previous?.version ?? 0) + 1,
    expiresAt: now.getTime() + SESSION_MS,
    lastInteractionAt: now.getTime(),
  };
  const menu = (prefix = '') => {
    state.step = 'menu';
    state.view = null;
    state.offset = 0;
    state.prompt = {
      type: 'buttons',
      body: `${prefix}${prefix ? '\n' : ''}Doctor menu`,
      choices: menuChoices,
    };
  };
  const finish = (): DoctorOutcome => ({
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
  if (!clinic) {
    state.prompt = { type: 'text', body: 'Clinic reports are unavailable.' };
    return finish();
  }
  const date = localDateAt(now, clinic.timezone);
  const text =
    incoming.input.type === 'text'
      ? incoming.input.value.trim().toLowerCase()
      : '';
  const action =
    valid && incoming.input.type === 'action' && previous.prompt.type !== 'text'
      ? previous.prompt.choices.find(
          (c) => `${previous.token}:${c.id}` === incoming.input.value,
        )?.id
      : undefined;
  if (!valid || ['menu', 'doctor', 'restart', 'hi', 'hello'].includes(text)) {
    menu();
    return finish();
  }
  if (!action) return finish();
  // The repository query is already scoped; filter defensively before any report/detail.
  const appointments = (await unit.listAppointments(date)).filter(
    (a) => a.clinicId === clinic.clinicId && a.appointmentDate === date,
  );
  if (state.step === 'menu' && action === 'summary') {
    const count = (status: Appointment['status']) =>
      appointments.filter((a) => a.status === status).length;
    const operationalTotal =
      count('Scheduled') +
      count('CheckedIn') +
      count('Completed') +
      count('NoShow');
    menu(
      `Daily summary — ${date} (${clinic.timezone})\nOperational total: ${operationalTotal}\nScheduled: ${count('Scheduled')}\nChecked In: ${count('CheckedIn')}\nCompleted: ${count('Completed')}\nNo Show: ${count('NoShow')}\nCancelled: ${count('Cancelled')}\nRescheduled: ${count('Rescheduled')}`,
    );
    return finish();
  }
  if (state.step === 'menu' && (action === 'today' || action === 'queue')) {
    state.view = action;
    state.offset = 0;
  } else if (state.step === 'list' && action === 'more') state.offset += 9;
  const rows =
    state.view === 'queue'
      ? orderCheckedInQueue(appointments, clinic.clinicId, date)
      : [...appointments].sort((a, b) =>
          `${a.startTime}:${a.appointmentId}`.localeCompare(
            `${b.startTime}:${b.appointmentId}`,
          ),
        );
  if (state.step === 'list' && action.startsWith('appointment:')) {
    const a = rows.find((a) => a.appointmentId === action.slice(12));
    menu(
      a
        ? `${state.view === 'queue' && rows[0]?.appointmentId === a.appointmentId ? 'Next patient\n' : ''}${date} ${formatClinicTimeRange(a.startTime, a.endTime)} (${clinic.timezone})\n${a.patientName.slice(0, 80)}\n${a.status} · ${a.source}`
        : 'That appointment is no longer in this view.',
    );
    return finish();
  }
  if (!rows.length) {
    menu(
      `${date} (${clinic.timezone})\n${state.view === 'queue' ? 'No patients are waiting.' : 'No appointments today.'}`,
    );
    return finish();
  }
  if (state.offset >= rows.length) state.offset = 0;
  state.step = 'list';
  const choices: Choice[] = rows
    .slice(state.offset, state.offset + 9)
    .map((a) => ({
      id: `appointment:${a.appointmentId}`,
      title: `${formatClinicTime(a.startTime)} ${a.patientName}`.slice(0, 24),
      description: `${state.view === 'queue' && rows[0]?.appointmentId === a.appointmentId ? 'Next patient · ' : ''}${a.status} · ${a.source}`,
    }));
  if (state.offset + 9 < rows.length)
    choices.push({ id: 'more', title: 'More' });
  state.prompt = {
    type: 'list',
    body: `${state.view === 'queue' ? 'Waiting queue' : "Today's appointments"} — ${date} (${clinic.timezone})${state.view === 'queue' ? `\nNext: ${rows[0]!.patientName.slice(0, 80)} at ${formatClinicTime(rows[0]!.startTime)}` : ''}`,
    choices,
  };
  return finish();
}
