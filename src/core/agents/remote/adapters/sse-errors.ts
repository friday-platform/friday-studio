/**
 * SSE-specific error types for Server-Sent Events processing
 * Based on acp-sdk implementation patterns
 */

export class BaseError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    Object.setPrototypeOf(this, new.target.prototype);

    // Capture stack trace if available (Node.js-style error handling)
    const ErrorConstructor = Error as typeof Error & {
      captureStackTrace?: (target: Error, constructor: new (...args: unknown[]) => Error) => void;
    };

    if (ErrorConstructor.captureStackTrace) {
      ErrorConstructor.captureStackTrace(this, this.constructor);
    }
  }
}

export class FetchError extends BaseError {
  constructor(
    message: string,
    public response?: Response,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "FetchError";
  }
}

export class SSEError extends BaseError {
  constructor(
    message: string,
    public response: Response,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SSEError";
  }
}

export class HTTPError extends BaseError {
  statusCode: number;
  headers: Headers;
  body?: unknown;

  constructor(response: Response, body?: unknown) {
    super(`HTTPError: status ${response.status}`);
    this.name = "HTTPError";
    this.statusCode = response.status;
    this.headers = response.headers;
    this.body = body;
  }
}

export class ACPError extends BaseError {
  error: { code: string; message: string };
  code: string;

  constructor(error: { code: string; message: string }) {
    super(error.message);
    this.name = "ACPError";
    this.error = error;
    this.code = error.code;
  }
}
