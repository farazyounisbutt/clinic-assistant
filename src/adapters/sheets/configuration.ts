import { ProjectionFailure } from '../../projection/errors.js';
import type { ClinicSheetTarget } from './projection.js';
export interface GoogleProjectionEnvironment {
  readonly GOOGLE_SERVICE_ACCOUNT_EMAIL?: string;
  readonly GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?: string;
  /** JSON clinic-ID -> spreadsheet-ID map; runtime-only, never request input. */
  readonly GOOGLE_SHEETS_TARGETS?: string;
}
export function configuredTarget(
  env: GoogleProjectionEnvironment,
  clinicId: string,
): ClinicSheetTarget {
  try {
    const targets: unknown = JSON.parse(env.GOOGLE_SHEETS_TARGETS ?? '');
    if (!targets || typeof targets !== 'object' || Array.isArray(targets))
      throw new Error();
    const entries = Object.entries(targets);
    const seen = new Set<string>();
    for (const [id, target] of entries) {
      if (
        !id.trim() ||
        typeof target !== 'string' ||
        !/^[\w-]+$/.test(target) ||
        seen.has(target)
      )
        throw new Error();
      seen.add(target);
    }
    const match = entries.find(([id]) => id === clinicId);
    if (!match) throw new Error();
    return { clinicId, spreadsheetId: match[1] as string };
  } catch {
    throw new ProjectionFailure('Configuration');
  }
}
