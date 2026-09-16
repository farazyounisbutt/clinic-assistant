import type {
  ClinicOperator,
  OperatorDirectory,
} from '../../ports/operators.js';
import { noOperators } from '../../ports/operators.js';
/** Secret-backed POC adapter. Invalid/ambiguous configuration grants no privileges. */
export function configuredOperators(raw?: string): OperatorDirectory {
  if (!raw) return noOperators;
  try {
    const rows: unknown = JSON.parse(raw);
    if (!Array.isArray(rows) || rows.length > 1000) return noOperators;
    const entries = new Map<string, ClinicOperator>();
    const ids = new Set<string>();
    for (const row of rows as Record<string, unknown>[]) {
      if (
        !row ||
        typeof row !== 'object' ||
        typeof row.clinicId !== 'string' ||
        !/^[a-zA-Z0-9_-]{1,100}$/.test(row.clinicId) ||
        typeof row.sender !== 'string' ||
        !/^[1-9]\d{7,14}$/.test(row.sender) ||
        typeof row.operatorId !== 'string' ||
        !/^[a-zA-Z0-9_-]{1,80}$/.test(row.operatorId) ||
        (row.role !== 'Clerk' && row.role !== 'Doctor')
      )
        return noOperators;
      const key = `${row.clinicId}:${row.sender}`;
      const id = `${row.clinicId}:${row.operatorId}`;
      if (entries.has(key) || ids.has(id)) return noOperators;
      entries.set(key, { operatorId: row.operatorId, role: row.role });
      ids.add(id);
    }
    return {
      resolve: (clinicId, identity) => {
        const entry = entries.get(`${clinicId}:${identity}`);
        return entry ? { ...entry } : null;
      },
    };
  } catch {
    return noOperators;
  }
}
