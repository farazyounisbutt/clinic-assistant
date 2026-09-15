/** Safe classifications shared by delivery adapters and the durable outbox. */
export type ProjectionFailureCategory =
  | 'Authentication'
  | 'Authorization'
  | 'TargetUnavailable'
  | 'Schema'
  | 'RateLimited'
  | 'Transient'
  | 'MalformedPayload'
  | 'Configuration';
const messages: Record<ProjectionFailureCategory, string> = {
  Authentication: 'Google service-account credentials are invalid',
  Authorization: 'Google Sheets access is not authorized',
  TargetUnavailable: 'Spreadsheet is missing or inaccessible',
  Schema: 'Spreadsheet structure does not match projection schema',
  RateLimited: 'Google request rate limit reached',
  Transient: 'Projection service is temporarily unavailable',
  MalformedPayload: 'Projection payload is invalid',
  Configuration: 'Clinic projection configuration is invalid or missing',
};
export class ProjectionFailure extends Error {
  override readonly name = 'ProjectionFailure';
  readonly retryAfterMs: number;
  constructor(
    readonly category: ProjectionFailureCategory,
    retryAfterMs = 0,
  ) {
    super(messages[category]);
    this.retryAfterMs = Number.isFinite(retryAfterMs)
      ? Math.max(0, Math.min(retryAfterMs, 3_600_000))
      : 0;
  }
  get automaticRetry(): boolean {
    return this.category === 'Transient' || this.category === 'RateLimited';
  }
}
export function classifyProjectionFailure(error: unknown): ProjectionFailure {
  // Never persist arbitrary exception messages or Google response bodies.
  return error instanceof ProjectionFailure
    ? new ProjectionFailure(error.category, error.retryAfterMs)
    : new ProjectionFailure('Transient');
}
