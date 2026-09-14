import type { Timestamp } from '../shared/types.js';

/** Administrative contact record only; never add clinical records here. */
export interface Patient {
  readonly patientId: string;
  readonly clinicId: string;
  readonly name: string;
  readonly whatsappNumber: string;
  readonly createdAt: Timestamp;
}
