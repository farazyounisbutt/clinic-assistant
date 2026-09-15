import { ProjectionFailure } from '../../projection/errors.js';
export type GoogleFetch = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;
/** Timeout includes consumption of the response body. Redirects never receive credentials. */
export async function googleJson(
  request: GoogleFetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  auth = false,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await request(url, {
      ...init,
      signal: controller.signal,
      redirect: 'error',
    });
    if (!response.ok) {
      const status = response.status;
      const retry = response.headers.get('Retry-After');
      const retryAfter =
        retry && /^\d+$/.test(retry)
          ? Math.min(Number(retry) * 1000, 3_600_000)
          : 0;
      // Do not read potentially sensitive error bodies.
      await response.body?.cancel();
      if (status === 429)
        throw new ProjectionFailure('RateLimited', retryAfter);
      if (status >= 500 || status === 408)
        throw new ProjectionFailure('Transient', retryAfter);
      if (status === 401 || (auth && status === 400))
        throw new ProjectionFailure('Authentication');
      if (status === 403) throw new ProjectionFailure('Authorization');
      if (status === 404) throw new ProjectionFailure('TargetUnavailable');
      throw new ProjectionFailure('Schema');
    }
    try {
      return await response.json();
    } catch {
      throw new ProjectionFailure('Transient');
    }
  } catch (error) {
    if (error instanceof ProjectionFailure) throw error;
    throw new ProjectionFailure('Transient');
  } finally {
    clearTimeout(timer);
  }
}
