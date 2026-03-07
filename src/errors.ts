export class SDKError extends Error {
  readonly status?: number;
  readonly details?: unknown;

  constructor(message: string, options?: { status?: number; details?: unknown; cause?: unknown }) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = 'SDKError';
    this.status = options?.status;
    this.details = options?.details;
  }
}

export class APIError extends SDKError {
  constructor(message: string, options?: { status?: number; details?: unknown; cause?: unknown }) {
    super(message, options);
    this.name = 'APIError';
  }
}