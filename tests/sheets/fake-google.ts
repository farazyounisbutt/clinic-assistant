import { SHEET_COLUMNS } from '../../src/projection/sheets.js';
import type { SheetName } from '../../src/ports/projection.js';
export type Cell = string | number | boolean | null;
interface Sheet {
  properties: {
    sheetId: number;
    title: string;
    sheetType: string;
    gridProperties: { rowCount: number; columnCount: number };
  };
  rows: Cell[][];
}
/** Stateful fake of HTTP responses/requests, not of the production adapter. */
export class FakeGoogleSheets {
  readonly sheets: Sheet[] = [];
  metadata: {
    metadataId: number;
    metadataKey: string;
    metadataValue: string;
    visibility: string;
    location: { spreadsheet: boolean };
  }[] = [];
  writes = 0;
  failStatus = 0;
  loseAcknowledgement = false;
  constructor(
    readonly clinicId = 'demo_clinic',
    ready = true,
  ) {
    if (ready) {
      for (const [name, columns] of Object.entries(SHEET_COLUMNS))
        this.add(name, [...columns]);
      this.metadata = [
        {
          metadataId: 1,
          metadataKey: 'clinic_assistant_projection',
          metadataValue: JSON.stringify({
            schemaVersion: 1,
            clinicId,
            revision: 0,
          }),
          visibility: 'DOCUMENT',
          location: { spreadsheet: true },
        },
      ];
    } else this.add('Sheet1', []);
  }
  add(name: string, header: Cell[]) {
    this.sheets.push({
      properties: {
        sheetId: this.sheets.length,
        title: name,
        sheetType: 'GRID',
        gridProperties: { rowCount: 100, columnCount: 26 },
      },
      rows: header.length ? [header] : [],
    });
  }
  rows(name: SheetName): Cell[][] {
    return this.sheets
      .find((s) => s.properties.title === name)!
      .rows.slice(1)
      .filter((r) => r.some((c) => c !== null && c !== ''));
  }
  fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    if (this.failStatus)
      return new Response('Synthetic private diagnostic', {
        status: this.failStatus,
        headers: { 'Retry-After': '120' },
      });
    if (url.pathname.endsWith(':batchUpdate')) {
      // Trusted test-generated request types, interpreted to reproduce the relevant API semantics.
      const body = JSON.parse(String(init!.body)) as {
        requests: Array<Record<string, Record<string, unknown>>>;
      };
      for (const request of body.requests) {
        if (request.addSheet) {
          const properties = request.addSheet.properties as Pick<
            Sheet['properties'],
            'sheetId' | 'title'
          > &
            Partial<Sheet['properties']>;
          this.sheets.push({
            properties: {
              sheetType: 'GRID',
              gridProperties: { rowCount: 100, columnCount: 26 },
              ...properties,
            },
            rows: [],
          });
        }
        if (request.updateCells) {
          const update = request.updateCells as unknown as {
            range: {
              sheetId: number;
              startRowIndex?: number;
              endRowIndex: number;
            };
            rows?: {
              values: {
                userEnteredValue?: {
                  stringValue?: string;
                  numberValue?: number;
                  boolValue?: boolean;
                };
              }[];
            }[];
          };
          const sheet = this.sheets.find(
            (s) => s.properties.sheetId === update.range.sheetId,
          )!;
          const start = update.range.startRowIndex ?? 0;
          for (let index = start; index < update.range.endRowIndex; index++)
            sheet.rows[index] = (
              update.rows?.[index - start]?.values ?? []
            ).map(
              (c) =>
                c.userEnteredValue?.stringValue ??
                c.userEnteredValue?.numberValue ??
                c.userEnteredValue?.boolValue ??
                null,
            );
        }
        if (request.appendDimension) {
          const r = request.appendDimension;
          this.sheets.find(
            (s) => s.properties.sheetId === r.sheetId,
          )!.properties.gridProperties[
            r.dimension === 'COLUMNS' ? 'columnCount' : 'rowCount'
          ] += Number(r.length);
        }
        if (request.createDeveloperMetadata)
          this.metadata.push({
            ...(request.createDeveloperMetadata
              .developerMetadata as (typeof this.metadata)[number]),
            metadataId: 1,
          });
        if (request.updateDeveloperMetadata)
          this.metadata[0]!.metadataValue = (
            request.updateDeveloperMetadata.developerMetadata as {
              metadataValue: string;
            }
          ).metadataValue;
      }
      this.writes++;
      if (this.loseAcknowledgement) {
        this.loseAcknowledgement = false;
        throw new Error('Lost response');
      }
      return Response.json({ replies: [] });
    }
    if (url.pathname.endsWith('/values:batchGet'))
      return Response.json({
        valueRanges: url.searchParams.getAll('ranges').map((range) => ({
          range,
          values: this.sheets.find(
            (s) => `'${s.properties.title.replace(/'/g, "''")}'` === range,
          )!.rows,
        })),
      });
    return Response.json({
      sheets: this.sheets.map((s) => ({ properties: s.properties })),
      developerMetadata: this.metadata,
    });
  };
}
