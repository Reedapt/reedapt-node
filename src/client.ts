import { randomUUID } from "node:crypto";
import {
  APIError,
  ConnectionError,
  ReedaptError,
  TimeoutError,
  type ErrorBody,
} from "./errors.ts";
import { Dubs } from "./resources/dubs.ts";
import { Uploads, type UploadInput, type UploadFileOptions } from "./resources/uploads.ts";
import { WebhookEndpoints } from "./resources/webhook-endpoints.ts";
import type { CreateDubsParams, DubsCreated, Languages, Usage, UsageReport } from "./types.ts";
import { VERSION } from "./version.ts";
import { Webhooks } from "./webhooks.ts";

export interface ClientOptions {
  /** Defaults to the `REEDAPT_API_KEY` environment variable. */
  apiKey?: string;
  /** Defaults to `REEDAPT_BASE_URL`, then `https://api.reedapt.com/v1`. */
  baseURL?: string;
  /** Milliseconds before a request is abandoned. Defaults to 60 seconds. */
  timeout?: number;
  /** How many times to retry a request that failed in a way worth retrying. Defaults to 2. */
  maxRetries?: number;
  /** A `fetch` to use instead of the global one. */
  fetch?: typeof fetch;
  defaultHeaders?: Record<string, string>;
}

export interface RequestOptions {
  /** Sent as `Idempotency-Key`. Creating uploads and dubs gets one automatically. */
  idempotencyKey?: string;
  timeout?: number;
  maxRetries?: number;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

/**
 * `safe` requests can be sent again after any failure without doing the work
 * twice. `unsafe` ones are only retried when the API refused them before acting.
 */
type Retry = "safe" | "unsafe";

interface Request {
  method: "GET" | "POST" | "DELETE";
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  retry: Retry;
  idempotent?: boolean;
}

export type DubFileParams = Omit<CreateDubsParams, "upload_id"> &
  Omit<UploadFileOptions, "idempotencyKey"> & {
    /** Used for both the upload and the dubs, with a suffix for each. */
    idempotencyKey?: string;
  };

const DEFAULT_BASE_URL = "https://api.reedapt.com/v1";

function env(name: string): string | undefined {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env?.[name] || undefined;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    function abort() {
      clearTimeout(timer);
      reject(signal!.reason);
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export function backoff(attempt: number): number {
  return Math.min(500 * 2 ** attempt, 8000) * (0.75 + Math.random() * 0.25);
}

export class Reedapt {
  readonly baseURL: string;
  readonly timeout: number;
  readonly maxRetries: number;
  readonly uploads: Uploads;
  readonly dubs: Dubs;
  readonly webhookEndpoints: WebhookEndpoints;
  readonly webhooks: Webhooks;
  readonly languages: { list: (options?: RequestOptions) => Promise<Languages> };
  readonly usage: {
    retrieve: (options?: RequestOptions) => Promise<Usage>;
    /** A month (`YYYY-MM`, UTC; default this month) of minutes and dubs, per key and per language. */
    report: (params?: { month?: string }, options?: RequestOptions) => Promise<UsageReport>;
  };
  /** @internal */
  readonly fetch: typeof fetch;
  readonly #apiKey: string;
  readonly #defaultHeaders: Record<string, string>;

  constructor(options: ClientOptions = {}) {
    const apiKey = options.apiKey ?? env("REEDAPT_API_KEY");
    if (!apiKey) {
      throw new ReedaptError(
        "No API key. Pass { apiKey } or set the REEDAPT_API_KEY environment variable.",
      );
    }
    this.#apiKey = apiKey;
    this.baseURL = (options.baseURL ?? env("REEDAPT_BASE_URL") ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeout = options.timeout ?? 60_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#defaultHeaders = options.defaultHeaders ?? {};

    this.uploads = new Uploads(this);
    this.dubs = new Dubs(this);
    this.webhookEndpoints = new WebhookEndpoints(this);
    this.webhooks = new Webhooks();
    this.languages = {
      list: (o) => this.request({ method: "GET", path: "/languages", retry: "safe" }, o),
    };
    this.usage = {
      retrieve: (o) => this.request({ method: "GET", path: "/usage", retry: "safe" }, o),
      report: (params = {}, o) =>
        this.request({ method: "GET", path: "/usage/report", query: { ...params }, retry: "safe" }, o),
    };
  }

  /**
   * Uploads a file (or fetches a public link) and starts a dub for each
   * target language. Resolves once the dubs have started, not when they finish.
   */
  async dub(input: UploadInput | URL, params: DubFileParams): Promise<DubsCreated> {
    const { filename, concurrency, onProgress, signal, idempotencyKey, ...dubParams } = params;
    const key = (suffix: string) => (idempotencyKey ? `${idempotencyKey}:${suffix}` : undefined);
    const isLink =
      input instanceof URL || (typeof input === "string" && /^https?:\/\//i.test(input));
    const upload = isLink
      ? await this.uploads.fromUrl(String(input), { filename, signal, idempotencyKey: key("upload") })
      : await this.uploads.uploadFile(input as UploadInput, {
          filename,
          concurrency,
          onProgress,
          signal,
          idempotencyKey: key("upload"),
        });
    return this.dubs.create(
      { ...dubParams, upload_id: upload.id },
      { signal, idempotencyKey: key("dubs") },
    );
  }

  /** @internal */
  async request<T>(req: Request, options: RequestOptions = {}): Promise<T> {
    const url = new URL(this.baseURL + req.path);
    for (const [name, value] of Object.entries(req.query ?? {})) {
      if (value !== undefined) url.searchParams.set(name, String(value));
    }
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": `reedapt-node/${VERSION}`,
      ...this.#defaultHeaders,
      ...options.headers,
      Authorization: `Bearer ${this.#apiKey}`,
    };
    if (req.body !== undefined) headers["Content-Type"] = "application/json";
    const idempotencyKey =
      options.idempotencyKey ?? (req.idempotent ? randomUUID() : undefined);
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    // A request carrying an idempotency key is safe to send again.
    const retry: Retry = idempotencyKey ? "safe" : req.retry;
    const body = req.body === undefined ? undefined : JSON.stringify(req.body);
    const maxRetries = options.maxRetries ?? this.maxRetries;

    for (let attempt = 0; ; attempt++) {
      let error: ReedaptError;
      try {
        const res = await this.#send(url, req.method, headers, body, options);
        if (res.ok) {
          if (res.status === 204) return undefined as T;
          const text = await res.text();
          return (text ? JSON.parse(text) : undefined) as T;
        }
        error = APIError.from(res.status, await readError(res), res.headers);
      } catch (e) {
        if (!(e instanceof ConnectionError)) throw e;
        error = e;
      }
      if (attempt >= maxRetries || !shouldRetry(error, retry)) throw error;
      await sleep(retryDelay(error, attempt), options.signal);
    }
  }

  async #send(
    url: URL,
    method: string,
    headers: Record<string, string>,
    body: string | undefined,
    options: RequestOptions,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = options.timeout ?? this.timeout;
    const timer = setTimeout(() => controller.abort(new TimeoutError("timeout")), timeout);
    const onAbort = () => controller.abort(options.signal!.reason);
    if (options.signal?.aborted) onAbort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await this.fetch(url, { method, headers, body, signal: controller.signal });
      // Read the body inside the timeout, so a stalled answer also times out.
      return new Response(res.status === 204 ? null : await res.arrayBuffer(), {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      });
    } catch (e) {
      if (options.signal?.aborted) throw options.signal.reason;
      if (controller.signal.reason instanceof TimeoutError) {
        throw new TimeoutError(`${method} ${url.pathname} took longer than ${timeout} ms.`);
      }
      throw new ConnectionError(`${method} ${url.pathname} failed: ${(e as Error).message}`, {
        cause: e,
      });
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }
}

async function readError(res: Response): Promise<ErrorBody | undefined> {
  try {
    const json = (await res.json()) as { error?: ErrorBody };
    return json?.error;
  } catch {
    return undefined;
  }
}

function shouldRetry(error: ReedaptError, retry: Retry): boolean {
  if (error instanceof ConnectionError) return retry === "safe";
  if (!(error instanceof APIError)) return false;
  // These 429s are limits that last minutes or hours, not a busy minute.
  if (error.status === 429) return error.code === "RATE_LIMITED";
  if (error.status === 503) return true;
  if (retry === "unsafe") return false;
  if (error.status === 409) return error.code === "IDEMPOTENCY_IN_PROGRESS";
  return error.status === 408 || error.status === 500 || error.status === 502 || error.status === 504;
}

function retryDelay(error: ReedaptError, attempt: number): number {
  if (error instanceof APIError) {
    const seconds = Number(error.headers.get("retry-after"));
    if (Number.isFinite(seconds) && seconds >= 0 && seconds <= 60) return seconds * 1000;
  }
  return backoff(attempt);
}
