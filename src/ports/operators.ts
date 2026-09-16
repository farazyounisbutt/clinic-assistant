export type OperatorRole = 'Clerk' | 'Doctor';
export interface ClinicOperator {
  readonly operatorId: string;
  readonly role: OperatorRole;
}
/** Trusted, clinic-scoped lookup. Implementations must not infer roles from input text. */
export interface OperatorDirectory {
  resolve(clinicId: string, identity: string): ClinicOperator | null;
}
export const noOperators: OperatorDirectory = { resolve: () => null };
