import type { GoogleTokenProvider } from './auth.js';
import { googleJson } from './http.js';
import type { GoogleFetch } from './http.js';
import { ProjectionFailure } from '../../projection/errors.js';
export class GoogleSheetsClient {
  constructor(
    private readonly tokens: GoogleTokenProvider,
    private readonly request: GoogleFetch = fetch,
    private readonly timeoutMs = 10_000,
  ) {}
  private async call(
    target: string,
    suffix: string,
    body?: unknown,
  ): Promise<unknown> {
    if (!/^[\w-]+$/.test(target)) throw new ProjectionFailure('Configuration');
    for (let attempt = 0; ; attempt++) {
      const token = await this.tokens.getToken();
      try {
        return await googleJson(
          this.request,
          `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(target)}${suffix}`,
          {
            method: body === undefined ? 'GET' : 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          },
          this.timeoutMs,
        );
      } catch (error) {
        if (
          error instanceof ProjectionFailure &&
          error.category === 'Authentication' &&
          attempt === 0
        ) {
          this.tokens.invalidate();
          continue;
        }
        throw error;
      }
    }
  }
  get(target: string): Promise<unknown> {
    return this.call(target, '?fields=sheets(properties),developerMetadata');
  }
  values(target: string, names: readonly string[]): Promise<unknown> {
    const params = new URLSearchParams({ valueRenderOption: 'FORMULA' });
    for (const name of names)
      params.append('ranges', `'${name.replace(/'/g, "''")}'`);
    return this.call(target, `/values:batchGet?${params}`);
  }
  batchUpdate(target: string, requests: readonly unknown[]): Promise<unknown> {
    return this.call(target, ':batchUpdate', {
      requests,
      includeSpreadsheetInResponse: false,
    });
  }
}
