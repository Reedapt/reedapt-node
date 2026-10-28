import { backoff, sleep, type Reedapt, type RequestOptions } from "../client.ts";
import { ConflictError, UploadError, WaitError } from "../errors.ts";
import type { CreateUploadParams, PartLink, Upload, UploadedPart } from "../types.ts";

/** A path on disk, or the file's bytes. */
export type UploadInput = string | Blob | ArrayBuffer | ArrayBufferView;

export interface UploadProgress {
  uploadedBytes: number;
  totalBytes: number;
}

export interface UploadFileOptions {
  /** Needed for bytes; taken from the path or `File` otherwise. Keep the extension. */
  filename?: string;
  /** Parts sent at once. Defaults to 4. Each holds one part (16 MiB or more) in memory. */
  concurrency?: number;
  onProgress?: (progress: UploadProgress) => void;
  signal?: AbortSignal;
  idempotencyKey?: string;
}

export interface WaitOptions {
  /** Milliseconds between checks. */
  pollInterval?: number;
  /** Milliseconds before giving up. */
  timeout?: number;
  signal?: AbortSignal;
}

export interface FromUrlOptions extends WaitOptions {
  /** Only when the link doesn't end in a file name. Keep the extension. */
  filename?: string;
  /** Wait until the download is done. Defaults to true. */
  wait?: boolean;
  idempotencyKey?: string;
}

interface Source {
  filename: string;
  size: number;
  read(start: number, end: number): Promise<Uint8Array>;
  close(): Promise<void>;
}

const SIGN_BATCH = 100;
const PART_ATTEMPTS = 4;

export class Uploads {
  readonly #client: Reedapt;

  constructor(client: Reedapt) {
    this.#client = client;
  }

  /** Starts an upload. Most code wants `uploadFile` or `fromUrl` instead. */
  create(params: CreateUploadParams, options?: RequestOptions): Promise<Upload> {
    return this.#client.request(
      { method: "POST", path: "/uploads", body: params, retry: "safe", idempotent: true },
      options,
    );
  }

  /** Signs links for up to 100 more parts. */
  signParts(
    uploadId: string,
    partNumbers: number[],
    options?: RequestOptions,
  ): Promise<{ parts: PartLink[] }> {
    return this.#client.request(
      {
        method: "POST",
        path: `/uploads/${encodeURIComponent(uploadId)}/parts`,
        body: { part_numbers: partNumbers },
        retry: "safe",
      },
      options,
    );
  }

  complete(uploadId: string, parts: UploadedPart[], options?: RequestOptions): Promise<Upload> {
    return this.#client.request(
      {
        method: "POST",
        path: `/uploads/${encodeURIComponent(uploadId)}/complete`,
        body: { parts },
        retry: "safe",
      },
      options,
    );
  }

  retrieve(uploadId: string, options?: RequestOptions): Promise<Upload> {
    return this.#client.request(
      { method: "GET", path: `/uploads/${encodeURIComponent(uploadId)}`, retry: "safe" },
      options,
    );
  }

  /**
   * Sends a file to storage in parts, in parallel, and completes the upload.
   * Expired links are signed again and failed parts are retried.
   */
  async uploadFile(input: UploadInput, options: UploadFileOptions = {}): Promise<Upload> {
    const { signal } = options;
    const source = await openSource(input, options.filename);
    try {
      const upload = await this.create(
        { filename: source.filename, size: source.size },
        { signal, idempotencyKey: options.idempotencyKey },
      );
      const links = new Map<number, string>();
      for (const part of upload.parts ?? []) links.set(part.part_number, part.url);

      const signing = new Map<number, Promise<void>>();
      const linkFor = async (n: number, refresh = false): Promise<string> => {
        if (refresh) links.delete(n);
        if (!links.has(n)) {
          const batch = refresh ? -n : Math.floor((n - 1) / SIGN_BATCH);
          if (!signing.has(batch)) {
            const first = refresh ? n : batch * SIGN_BATCH + 1;
            const last = refresh ? n : Math.min(first + SIGN_BATCH - 1, upload.part_count);
            const wanted: number[] = [];
            for (let p = first; p <= last; p++) if (!links.has(p)) wanted.push(p);
            signing.set(
              batch,
              this.signParts(upload.id, wanted, { signal })
                .then(({ parts }) => {
                  for (const part of parts) links.set(part.part_number, part.url);
                })
                .finally(() => signing.delete(batch)),
            );
          }
          await signing.get(batch);
        }
        const url = links.get(n);
        if (!url) throw new UploadError(`No link was signed for part ${n} of ${upload.id}.`);
        return url;
      };

      const done: UploadedPart[] = [];
      let uploadedBytes = 0;
      let next = 1;
      let stopped = false;
      const worker = async () => {
        while (!stopped && next <= upload.part_count) {
          const n = next++;
          const start = (n - 1) * upload.part_size;
          const end = Math.min(start + upload.part_size, source.size);
          const bytes = await source.read(start, end);
          const etag = await this.#putPart(upload.id, n, bytes, linkFor, signal);
          done.push({ part_number: n, etag });
          uploadedBytes += end - start;
          options.onProgress?.({ uploadedBytes, totalBytes: source.size });
        }
      };
      const workers = Math.max(1, Math.min(options.concurrency ?? 4, upload.part_count));
      // One failed part stops the others from starting new parts.
      await Promise.all(
        Array.from({ length: workers }, () =>
          worker().catch((e) => {
            stopped = true;
            throw e;
          }),
        ),
      );

      done.sort((a, b) => a.part_number - b.part_number);
      try {
        return await this.complete(upload.id, done, { signal });
      } catch (e) {
        // A retried complete that had already gone through.
        if (e instanceof ConflictError && e.code === "UPLOAD_COMPLETE") {
          return this.retrieve(upload.id, { signal });
        }
        throw e;
      }
    } finally {
      await source.close();
    }
  }

  async #putPart(
    uploadId: string,
    n: number,
    bytes: Uint8Array,
    linkFor: (n: number, refresh?: boolean) => Promise<string>,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    let refresh = false;
    let lastProblem = "";
    for (let attempt = 0; attempt < PART_ATTEMPTS; attempt++) {
      if (attempt > 0) await sleep(backoff(attempt), signal);
      const url = await linkFor(n, refresh);
      refresh = false;
      let res: Response;
      try {
        // No API key here: the signed link carries its own permission.
        res = await this.#client.fetch(url, { method: "PUT", body: bytes as BodyInit, signal });
      } catch (e) {
        if (signal?.aborted) throw signal.reason;
        lastProblem = (e as Error).message;
        continue;
      }
      await res.arrayBuffer().catch(() => undefined);
      if (res.ok) {
        const etag = res.headers.get("etag");
        if (!etag) {
          throw new UploadError(
            `Storage accepted part ${n} but sent no ETag. In a browser, the ETag header must be exposed.`,
          );
        }
        return etag;
      }
      lastProblem = `storage answered ${res.status}`;
      // An expired or refused link: sign this part again.
      if (res.status === 403 || res.status === 400) refresh = true;
      else if (res.status < 500 && res.status !== 408 && res.status !== 429) break;
    }
    throw new UploadError(`Part ${n} of upload ${uploadId} failed: ${lastProblem}.`);
  }

  /** Has Reedapt download a public link. Waits until it's ready unless `wait` is false. */
  async fromUrl(sourceUrl: string, options: FromUrlOptions = {}): Promise<Upload> {
    const params: CreateUploadParams = { source_url: sourceUrl };
    if (options.filename) params.filename = options.filename;
    const upload = await this.create(params, {
      signal: options.signal,
      idempotencyKey: options.idempotencyKey,
    });
    if (options.wait === false) return upload;
    return this.waitUntilReady(upload.id, options);
  }

  /** Polls an upload until it can be dubbed. Throws `WaitError` if it failed. */
  async waitUntilReady(uploadId: string, options: WaitOptions = {}): Promise<Upload> {
    const pollInterval = options.pollInterval ?? 10_000;
    const deadline = Date.now() + (options.timeout ?? 3 * 60 * 60 * 1000);
    for (;;) {
      const upload = await this.retrieve(uploadId, { signal: options.signal });
      if (upload.status === "uploaded") return upload;
      if (upload.status === "failed") {
        throw new WaitError(`Upload ${uploadId} failed: ${upload.error ?? "no reason given"}.`);
      }
      if (upload.status === "used") {
        throw new WaitError(`Upload ${uploadId} was already dubbed. Upload the file again.`);
      }
      if (Date.now() + pollInterval > deadline) {
        throw new WaitError(`Upload ${uploadId} was still ${upload.status} when the wait ran out.`);
      }
      await sleep(pollInterval, options.signal);
    }
  }
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

async function openSource(input: UploadInput, filename: string | undefined): Promise<Source> {
  if (typeof input === "string") {
    const fs = await import("node:fs/promises");
    const handle = await fs.open(input, "r");
    const { size } = await handle.stat();
    return {
      filename: filename ?? baseName(input),
      size,
      async read(start, end) {
        const buffer = new Uint8Array(end - start);
        let offset = 0;
        while (offset < buffer.length) {
          const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, start + offset);
          if (bytesRead === 0) throw new UploadError(`${input} got shorter while it was uploading.`);
          offset += bytesRead;
        }
        return buffer;
      },
      close: () => handle.close(),
    };
  }
  if (input instanceof ArrayBuffer || ArrayBuffer.isView(input)) {
    const bytes =
      input instanceof ArrayBuffer
        ? new Uint8Array(input)
        : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    if (!filename) throw new UploadError("Pass a filename, with its extension, when uploading bytes.");
    return {
      filename,
      size: bytes.byteLength,
      read: async (start, end) => bytes.subarray(start, end),
      close: async () => {},
    };
  }
  const blob = input;
  const name = filename ?? (blob as Blob & { name?: string }).name;
  if (!name) throw new UploadError("Pass a filename, with its extension, when uploading a Blob.");
  return {
    filename: name,
    size: blob.size,
    read: async (start, end) => new Uint8Array(await blob.slice(start, end).arrayBuffer()),
    close: async () => {},
  };
}
