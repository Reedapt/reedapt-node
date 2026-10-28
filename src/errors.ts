export interface FieldProblem {
  field: string;
  message: string;
}

export interface ErrorBody {
  code?: string;
  message?: string;
  request_id?: string;
  fields?: FieldProblem[];
}

/** Base class for everything the SDK throws. */
export class ReedaptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The API answered with an error. Branch on `code`, not on `message`. */
export class APIError extends ReedaptError {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | undefined;
  readonly fields: FieldProblem[] | undefined;
  readonly headers: Headers;

  constructor(
    status: number,
    body: ErrorBody | undefined,
    headers: Headers,
  ) {
    const code = body?.code ?? `HTTP_${status}`;
    super(`${code}: ${body?.message ?? `The API answered ${status}.`}`);
    this.status = status;
    this.code = code;
    this.requestId = body?.request_id ?? headers.get("request-id") ?? undefined;
    this.fields = body?.fields;
    this.headers = headers;
  }

  static from(
    status: number,
    body: ErrorBody | undefined,
    headers: Headers,
  ): APIError {
    const Kind =
      status === 401
        ? AuthenticationError
        : status === 404
          ? NotFoundError
          : status === 409
            ? ConflictError
            : status === 422 || status === 400 || status === 411 || status === 413
              ? InvalidRequestError
              : status === 429
                ? RateLimitError
                : status >= 500
                  ? ServerError
                  : APIError;
    return new Kind(status, body, headers);
  }
}

/** 401: the key is missing, wrong or revoked. */
export class AuthenticationError extends APIError {}
/** 404: nothing with this id belongs to the account. */
export class NotFoundError extends APIError {}
/** 409: the request conflicts with the object's state. */
export class ConflictError extends APIError {}
/** 4xx: the request can't be done as asked. Fix it before sending it again. */
export class InvalidRequestError extends APIError {}

/** 429: too many requests, or a limit such as dubs running at once. */
export class RateLimitError extends APIError {
  /** Seconds to wait, from the `Retry-After` header, when the API sent one. */
  get retryAfter(): number | undefined {
    const value = Number(this.headers.get("retry-after"));
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  }
}

/** 5xx: something went wrong on Reedapt's side. */
export class ServerError extends APIError {}

/** The request never got an answer: the network failed or it timed out. */
export class ConnectionError extends ReedaptError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }
}

export class TimeoutError extends ConnectionError {}

/** An upload part could not be sent to storage. */
export class UploadError extends ReedaptError {}

/** A `waitFor…` helper ran out of time, or the thing it waited on failed. */
export class WaitError extends ReedaptError {}

/** A webhook's signature didn't match, or its timestamp was too old. */
export class WebhookVerificationError extends ReedaptError {}
