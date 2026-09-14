import type {
  ClinicProjectionSnapshot,
  ClinicRecords,
  ProjectionRow,
  SheetName,
} from '../ports/projection.js';

/** Exact ordered v1 headers. Keys are scoped to a clinic and sheet. */
export const SHEET_COLUMNS = {
  Clinic_Settings: [
    'Record_Key',
    'Revision',
    'Clinic_ID',
    'Doctor_Name',
    'Specialty',
    'Timezone',
    'Appointment_Duration_Minutes',
    'Booking_Horizon_Days',
    'Same_Day_Booking_Allowed',
    'Subscription_Status',
  ],
  Working_Hours: [
    'Record_Key',
    'Revision',
    'Clinic_ID',
    'Day',
    'Active',
    'Start',
    'End',
    'Breaks_JSON',
  ],
  Blocked_Slots: [
    'Record_Key',
    'Revision',
    'Clinic_ID',
    'Block_ID',
    'Date',
    'Start',
    'End',
    'Reason',
  ],
  Appointments: [
    'Record_Key',
    'Revision',
    'Clinic_ID',
    'Appointment_ID',
    'Patient_ID',
    'Patient_Name',
    'WhatsApp_Number',
    'Date',
    'Start',
    'End',
    'Reason',
    'Source',
    'Status',
    'Booked_At',
    'Checked_In_At',
    'Completed_At',
    'Cancelled_At',
    'Rescheduled_From',
    'Rescheduled_To',
    'Created_By',
  ],
  Patients: [
    'Record_Key',
    'Revision',
    'Clinic_ID',
    'Patient_ID',
    'Name',
    'WhatsApp_Number',
    'Created_At',
  ],
  Activity_Log: [
    'Record_Key',
    'Revision',
    'Clinic_ID',
    'Event_ID',
    'Timestamp',
    'Actor_ID',
    'Action',
    'Appointment_ID',
    'Detail',
  ],
} as const satisfies Record<SheetName, readonly string[]>;

export function projectionSnapshot(
  clinicId: string,
  revision: number,
  records: ClinicRecords,
): ClinicProjectionSnapshot {
  const row = (
    key: string,
    ...values: ProjectionRow['cells']
  ): ProjectionRow => ({ key, cells: [key, revision, clinicId, ...values] });
  const c = records.clinic;
  return {
    schemaVersion: 1,
    clinicId,
    revision,
    sheets: {
      Clinic_Settings: c
        ? [
            row(
              c.clinicId,
              c.doctorName,
              c.specialty,
              c.timezone,
              c.appointmentDurationMinutes,
              c.bookingHorizonDays,
              c.sameDayBookingAllowed,
              c.subscriptionStatus,
            ),
          ]
        : [],
      Working_Hours: records.workingHours.map((h) =>
        row(
          `${h.dayOfWeek}:${h.startTime}:${h.endTime}`,
          h.dayOfWeek,
          h.active,
          h.startTime,
          h.endTime,
          JSON.stringify(h.breaks ?? []),
        ),
      ),
      Blocked_Slots: records.blockedSlots.map((b) =>
        row(b.id, b.id, b.date, b.startTime, b.endTime, b.reason),
      ),
      Appointments: records.appointments.map((a) =>
        row(
          a.appointmentId,
          a.appointmentId,
          a.patientId,
          a.patientName,
          a.whatsappNumber,
          a.appointmentDate,
          a.startTime,
          a.endTime,
          a.reason ?? null,
          a.source,
          a.status,
          a.bookedAt,
          a.checkedInAt,
          a.completedAt,
          a.cancelledAt,
          a.rescheduledFrom,
          a.rescheduledTo,
          a.createdBy,
        ),
      ),
      Patients: records.patients.map((p) =>
        row(p.patientId, p.patientId, p.name, p.whatsappNumber, p.createdAt),
      ),
      Activity_Log: records.activity.map((e) =>
        row(
          e.eventId,
          e.eventId,
          e.timestamp,
          e.actorId,
          e.action,
          e.appointmentId,
          e.detail,
        ),
      ),
    },
  };
}
