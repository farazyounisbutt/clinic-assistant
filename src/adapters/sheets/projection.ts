import type {
  ClinicProjectionSnapshot,
  ClinicRecordProjection,
  ProjectionRow,
  SheetName,
} from '../../ports/projection.js';
import { ProjectionFailure } from '../../projection/errors.js';
import { SHEET_COLUMNS } from '../../projection/sheets.js';
import type { GoogleSheetsClient } from './client.js';
export interface ClinicSheetTarget {
  readonly clinicId: string;
  readonly spreadsheetId: string;
}
interface GridSheet {
  id: number;
  name: string;
  rowCount: number;
  columnCount: number;
}
interface Marker {
  schemaVersion: 1;
  clinicId: string;
  revision: number;
  metadataId: number;
}
interface Spreadsheet {
  sheets: GridSheet[];
  metadata: unknown[];
}
type Cell = ProjectionRow['cells'][number];
const names = Object.keys(SHEET_COLUMNS) as SheetName[];
const markerKey = 'clinic_assistant_projection';
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ProjectionFailure('Schema');
  return value as Record<string, unknown>;
}
function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function cell(value: unknown): value is Cell {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}
function spreadsheet(value: unknown): Spreadsheet {
  const root = object(value);
  if (
    !Array.isArray(root.sheets) ||
    (root.developerMetadata !== undefined &&
      !Array.isArray(root.developerMetadata))
  )
    throw new ProjectionFailure('Schema');
  const sheets = root.sheets.map((s) => {
    const p = object(object(s).properties);
    const grid = object(p.gridProperties);
    if (
      !integer(p.sheetId) ||
      typeof p.title !== 'string' ||
      (p.sheetType !== undefined && p.sheetType !== 'GRID') ||
      !integer(grid.rowCount) ||
      !integer(grid.columnCount)
    )
      throw new ProjectionFailure('Schema');
    return {
      id: p.sheetId,
      name: p.title,
      rowCount: grid.rowCount,
      columnCount: grid.columnCount,
    };
  });
  if (new Set(sheets.map((s) => s.name)).size !== sheets.length)
    throw new ProjectionFailure('Schema');
  return { sheets, metadata: (root.developerMetadata ?? []) as unknown[] };
}
function marker(document: Spreadsheet, clinicId: string): Marker {
  const matches = document.metadata
    .map(object)
    .filter((m) => m.metadataKey === markerKey);
  if (matches.length !== 1) throw new ProjectionFailure('Schema');
  const entry = matches[0]!;
  let value: Record<string, unknown>;
  try {
    value = object(JSON.parse(String(entry.metadataValue)));
  } catch {
    throw new ProjectionFailure('Schema');
  }
  if (
    value.schemaVersion !== 1 ||
    !integer(value.revision) ||
    !integer(entry.metadataId) ||
    object(entry.location).spreadsheet !== true
  )
    throw new ProjectionFailure('Schema');
  if (value.clinicId !== clinicId) throw new ProjectionFailure('Configuration');
  return {
    schemaVersion: 1,
    clinicId,
    revision: value.revision,
    metadataId: entry.metadataId,
  };
}
function valueRanges(value: unknown, count: number): Cell[][][] {
  const ranges = object(value).valueRanges;
  if (!Array.isArray(ranges) || ranges.length !== count)
    throw new ProjectionFailure('Schema');
  return ranges.map((range) => {
    const rows = object(range).values ?? [];
    if (
      !Array.isArray(rows) ||
      !rows.every((r) => Array.isArray(r) && r.every(cell))
    )
      throw new ProjectionFailure('Schema');
    return rows as Cell[][];
  });
}
function rowValues(values: readonly Cell[]) {
  return {
    values: values.map((v) =>
      v === null
        ? {}
        : {
            userEnteredValue:
              typeof v === 'string'
                ? { stringValue: v }
                : typeof v === 'number'
                  ? { numberValue: v }
                  : { boolValue: v },
          },
    ),
  };
}
function validKey(
  name: SheetName,
  key: string,
  cells: readonly Cell[],
  clinicId: string,
): boolean {
  if (name === 'Clinic_Settings') return key === clinicId;
  if (name === 'Working_Hours')
    return key === `${cells[3]}:${cells[5]}:${cells[6]}`;
  return key === cells[3];
}
function validatePayload(
  snapshot: ClinicProjectionSnapshot,
  clinicId: string,
): void {
  if (
    !snapshot ||
    snapshot.schemaVersion !== 1 ||
    snapshot.clinicId !== clinicId ||
    !integer(snapshot.revision) ||
    snapshot.revision < 1 ||
    !snapshot.sheets
  )
    throw new ProjectionFailure('MalformedPayload');
  for (const name of names) {
    const rows = snapshot.sheets[name];
    const seen = new Set<string>();
    if (!Array.isArray(rows)) throw new ProjectionFailure('MalformedPayload');
    for (const row of rows) {
      if (
        !row ||
        typeof row.key !== 'string' ||
        !row.key ||
        seen.has(row.key) ||
        !Array.isArray(row.cells) ||
        row.cells.length !== SHEET_COLUMNS[name].length ||
        !row.cells.every(cell) ||
        row.cells[0] !== row.key ||
        row.cells[1] !== snapshot.revision ||
        row.cells[2] !== clinicId ||
        !validKey(name, row.key, row.cells, clinicId)
      )
        throw new ProjectionFailure('MalformedPayload');
      seen.add(row.key);
    }
  }
}
/** Sole writer is the clinic DO. Nothing read here enters the scheduling engine. */
export class GoogleSheetsProjection implements ClinicRecordProjection {
  constructor(
    private readonly target: ClinicSheetTarget,
    private readonly client: GoogleSheetsClient,
  ) {}
  private async inspect() {
    const document = spreadsheet(
      await this.client.get(this.target.spreadsheetId),
    );
    const state = marker(document, this.target.clinicId);
    const sheets = names.map((name) => {
      const sheet = document.sheets.find((s) => s.name === name);
      if (!sheet || sheet.columnCount < SHEET_COLUMNS[name].length)
        throw new ProjectionFailure('Schema');
      return sheet;
    });
    const values = valueRanges(
      await this.client.values(this.target.spreadsheetId, names),
      names.length,
    );
    let maximumRevision = state.revision;
    const indices = values.map((rows, index) => {
      const name = names[index]!;
      const width = SHEET_COLUMNS[name].length;
      if (JSON.stringify(rows[0]) !== JSON.stringify(SHEET_COLUMNS[name]))
        throw new ProjectionFailure('Schema');
      const keys = new Map<string, { index: number; revision: number }>();
      rows.slice(1).forEach((row, index) => {
        if (row.every((c) => c === null || c === '')) return;
        const [key, revision, clinicId] = row;
        if (
          typeof key !== 'string' ||
          !key ||
          !integer(revision) ||
          clinicId !== this.target.clinicId ||
          row.length > width ||
          keys.has(key) ||
          !validKey(name, key, row, clinicId)
        )
          throw new ProjectionFailure('Schema');
        maximumRevision = Math.max(maximumRevision, revision);
        keys.set(key, { index, revision });
      });
      return keys;
    });
    // All writes include the marker in one atomic batch. A row beyond that marker
    // signals external modification or incompatible delivery; never acknowledge it.
    if (maximumRevision > state.revision) throw new ProjectionFailure('Schema');
    return { state, sheets, values, indices, maximumRevision };
  }
  async validate(): Promise<Marker> {
    return (await this.inspect()).state;
  }
  /** Explicit only: refuses cells or foreign metadata before creating anything. */
  async bootstrap(): Promise<void> {
    const document = spreadsheet(
      await this.client.get(this.target.spreadsheetId),
    );
    if (document.metadata.some((m) => object(m).metadataKey === markerKey)) {
      await this.validate();
      return;
    }
    if (document.metadata.length) throw new ProjectionFailure('Schema');
    if (document.sheets.length) {
      const content = valueRanges(
        await this.client.values(
          this.target.spreadsheetId,
          document.sheets.map((s) => s.name),
        ),
        document.sheets.length,
      );
      if (
        content.some((rows) =>
          rows.some((row) => row.some((c) => c !== null && c !== '')),
        )
      )
        throw new ProjectionFailure('Schema');
    }
    const requests: unknown[] = [];
    let id = Math.max(-1, ...document.sheets.map((s) => s.id)) + 1;
    for (const name of names) {
      let sheet = document.sheets.find((s) => s.name === name);
      if (!sheet) {
        sheet = { id: id++, name, rowCount: 100, columnCount: 26 };
        requests.push({
          addSheet: {
            properties: {
              sheetId: sheet.id,
              title: name,
              gridProperties: {
                rowCount: 100,
                columnCount: 26,
                frozenRowCount: 1,
              },
            },
          },
        });
      }
      if (sheet.columnCount < SHEET_COLUMNS[name].length || sheet.rowCount < 1)
        throw new ProjectionFailure('Schema');
      requests.push({
        updateCells: {
          range: {
            sheetId: sheet.id,
            startRowIndex: 0,
            endRowIndex: 1,
            startColumnIndex: 0,
            endColumnIndex: SHEET_COLUMNS[name].length,
          },
          rows: [rowValues(SHEET_COLUMNS[name])],
          fields: 'userEnteredValue',
        },
      });
    }
    requests.push({
      createDeveloperMetadata: {
        developerMetadata: {
          metadataKey: markerKey,
          metadataValue: JSON.stringify({
            schemaVersion: 1,
            clinicId: this.target.clinicId,
            revision: 0,
          }),
          visibility: 'DOCUMENT',
          location: { spreadsheet: true },
        },
      },
    });
    await this.write(requests);
  }
  async applySnapshot(snapshot: ClinicProjectionSnapshot): Promise<void> {
    validatePayload(snapshot, this.target.clinicId);
    const { state, sheets, values, indices, maximumRevision } =
      await this.inspect();
    if (maximumRevision >= snapshot.revision) return;
    const requests: unknown[] = [];
    for (let index = 0; index < names.length; index++) {
      const name = names[index]!;
      const sheet = sheets[index]!;
      const keys = indices[index]!;
      const next: (readonly Cell[] | undefined)[] = Array.from({
        length: Math.max(0, values[index]!.length - 1),
      });
      const newRows: ProjectionRow[] = [];
      for (const row of snapshot.sheets[name]) {
        const existing = keys.get(row.key);
        if (existing) next[existing.index] = row.cells;
        else newRows.push(row);
      }
      for (const row of newRows) {
        const free = next.findIndex((r) => r === undefined);
        if (free < 0) next.push(row.cells);
        else next[free] = row.cells;
      }
      const end = next.length + 1;
      if (end > sheet.rowCount)
        requests.push({
          appendDimension: {
            sheetId: sheet.id,
            dimension: 'ROWS',
            length: end - sheet.rowCount,
          },
        });
      if (next.length)
        requests.push({
          updateCells: {
            range: {
              sheetId: sheet.id,
              startRowIndex: 1,
              endRowIndex: end,
              startColumnIndex: 0,
              endColumnIndex: SHEET_COLUMNS[name].length,
            },
            rows: next.map((r) => rowValues(r ?? [])),
            fields: 'userEnteredValue',
          },
        });
    }
    requests.push({
      updateDeveloperMetadata: {
        dataFilters: [
          { developerMetadataLookup: { metadataId: state.metadataId } },
        ],
        developerMetadata: {
          metadataValue: JSON.stringify({
            schemaVersion: 1,
            clinicId: this.target.clinicId,
            revision: snapshot.revision,
          }),
        },
        fields: 'metadataValue',
      },
    });
    await this.write(requests);
  }
  private async write(requests: readonly unknown[]): Promise<void> {
    // Keep a single batch so cells and revision commit together. Oversized snapshots
    // stay pending for operator action, never silently split across a revision marker.
    if (
      new TextEncoder().encode(JSON.stringify({ requests })).byteLength >
      1_800_000
    )
      throw new ProjectionFailure('MalformedPayload');
    try {
      await this.client.batchUpdate(this.target.spreadsheetId, requests);
    } catch (error) {
      // An aborted request might still run at Google. Wait beyond its documented
      // 180-second processing limit before another write can advance the revision.
      if (error instanceof ProjectionFailure && error.category === 'Transient')
        throw new ProjectionFailure('Transient', 210_000);
      throw error;
    }
  }
}
