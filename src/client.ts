import { APIError, SDKError } from './errors.js';
import type { ClientOptions, QueryValue, RequestOptions, SDKResponse } from './types.js';

const DEFAULT_TIMEOUT_MS = 30_000;

function appendQueryParam(searchParams: URLSearchParams, key: string, value: QueryValue): void {
  if (value === null || value === undefined) {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      searchParams.append(key, String(item));
    }
    return;
  }

  searchParams.append(key, String(value));
}

export function buildUrl(baseUrl: string, path: string, query?: Record<string, QueryValue>): URL {
  const url = new URL(path, baseUrl);

  if (!query) {
    return url;
  }

  for (const [key, value] of Object.entries(query)) {
    appendQueryParam(url.searchParams, key, value);
  }

  return url;
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') ?? '';

  if (contentType.includes('application/json')) {
    return response.json();
  }

  if (contentType.startsWith('text/')) {
    return response.text();
  }

  return response.arrayBuffer();
}

export class SDKClient {
  private readonly baseUrl: string;
  private readonly defaultHeaders: HeadersInit;
  private readonly timeoutMs: number;
  private readonly fetchImplementation: typeof globalThis.fetch;
  private readonly apiKey?: string;

  constructor(options: ClientOptions) {
    if (!options.baseUrl) {
      throw new SDKError('baseUrl is required');
    }

    this.baseUrl = options.baseUrl;
    this.apiKey = options.apiKey;
    this.defaultHeaders = options.headers ?? {};
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImplementation = options.fetch ?? globalThis.fetch;

    if (!this.fetchImplementation) {
      throw new SDKError('No fetch implementation available in this runtime');
    }
  }

  async request<TData>(options: RequestOptions): Promise<SDKResponse<TData>> {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), this.timeoutMs);
    const url = buildUrl(this.baseUrl, options.path, options.query);
    const headers = new Headers(this.defaultHeaders);

    if (options.headers) {
      new Headers(options.headers).forEach((value, key) => headers.set(key, value));
    }

    if (this.apiKey && !headers.has('authorization')) {
      headers.set('authorization', `Bearer ${this.apiKey}`);
    }

    const hasBody = options.body !== undefined && options.body !== null;
    if (hasBody && !headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }

    try {
      const response = await this.fetchImplementation(url, {
        method: options.method ?? 'GET',
        headers,
        body: hasBody ? JSON.stringify(options.body) : undefined,
        signal: options.signal ?? controller.signal,
      });

      const parsedBody = await parseResponseBody(response);

      if (!response.ok) {
        throw new APIError(`Request failed with status ${response.status}`, {
          status: response.status,
          details: parsedBody,
        });
      }

      return {
        data: parsedBody as TData,
        response,
      };
    } catch (error) {
      if (error instanceof APIError) {
        throw error;
      }

      if (error instanceof Error && error.name === 'AbortError') {
        throw new SDKError(`Request timed out after ${this.timeoutMs}ms`, {
          cause: error,
        });
      }

      throw new SDKError('Request failed before receiving a valid response', {
        cause: error,
      });
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  get<TData>(path: string, options?: Omit<RequestOptions, 'method' | 'path'>): Promise<SDKResponse<TData>> {
    return this.request<TData>({ ...options, method: 'GET', path });
  }

  post<TData>(path: string, options?: Omit<RequestOptions, 'method' | 'path'>): Promise<SDKResponse<TData>> {
    return this.request<TData>({ ...options, method: 'POST', path });
  }
}