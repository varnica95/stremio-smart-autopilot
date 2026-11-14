import type { RateLimiter } from '../../utils/rate-limiter.js';

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    message?: string,
  ) {
    super(message ?? `HTTP ${status} from ${new URL(url).host}`);
    this.name = 'HttpError';
  }
}

export interface RequestOptions {
  signal: AbortSignal;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
  rateLimiter?: RateLimiter;
}

/** Small JSON client used by every provider. Throws HttpError on non-2xx. */
export async function requestJson<T>(fetchImpl: FetchLike, url: string, options: RequestOptions): Promise<T> {
  await options.rateLimiter?.acquire(options.signal);
  const headers: Record<string, string> = { Accept: 'application/json', ...options.headers };
  let body: string | undefined;
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }
  const response = await fetchImpl(url, {
    method: options.method ?? 'GET',
    headers,
    body,
    signal: options.signal,
  });
  if (!response.ok) {
    // Drain the body so the connection can be reused.
    await response.text().catch(() => undefined);
    throw new HttpError(response.status, url);
  }
  return (await response.json()) as T;
}
