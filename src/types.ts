export type Primitive = string | number | boolean;

export type QueryValue = Primitive | Primitive[] | null | undefined;

export interface RequestOptions {
  path: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  query?: Record<string, QueryValue>;
  body?: unknown;
  headers?: HeadersInit;
  signal?: AbortSignal;
}

export interface ClientOptions {
  baseUrl: string;
  apiKey?: string;
  headers?: HeadersInit;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

export interface SDKResponse<TData> {
  data: TData;
  response: Response;
}