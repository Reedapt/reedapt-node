import { sleep, type Reedapt, type RequestOptions } from "../client.ts";
import { WaitError } from "../errors.ts";
import type {
  AnswerRunParams,
  CreateDubsParams,
  CreateRunParams,
  Dub,
  DubFiles,
  DubLines,
  DubList,
  DubsCreated,
  EditLinesParams,
  LinesEdited,
  ListDubsParams,
  Quality,
  Run,
  SubtitlesParams,
  Transcript,
} from "../types.ts";
import type { WaitOptions } from "./uploads.ts";

export interface WaitForDubOptions extends WaitOptions {
  /** Called after each check, for example to show progress. */
  onUpdate?: (dub: Dub) => void;
}

/** Asking Reedapt for changes to a finished dub. Early access. */
export class DubRequests {
  readonly #client: Reedapt;

  constructor(client: Reedapt) {
    this.#client = client;
  }

  /**
   * Hands Reedapt a request in plain words, such as "Make line 3 sound calmer".
   * With `autonomy: "ask"` (the default) nothing changes until you answer the
   * run with `runs.answer`. With `"decide"` Reedapt applies what it judges right.
   */
  create(dubId: string, params: CreateRunParams, options?: RequestOptions): Promise<Run> {
    // Not retried after a network failure: it could start the request twice.
    return this.#client.request(
      {
        method: "POST",
        path: `/dubs/${encodeURIComponent(dubId)}/requests`,
        body: { autonomy: "ask", ...params },
        retry: "unsafe",
      },
      options,
    );
  }
}

/** Reading and editing a finished dub's lines. Early access. */
export class DubLinesResource {
  readonly #client: Reedapt;

  constructor(client: Reedapt) {
    this.#client = client;
  }

  /** Every line with its timing, speaker, original and dubbed words, and delivery notes. */
  list(dubId: string, options?: RequestOptions): Promise<DubLines> {
    return this.#client.request(
      { method: "GET", path: `/dubs/${encodeURIComponent(dubId)}/lines`, retry: "safe" },
      options,
    );
  }

  /** Changes up to 100 lines. They are voiced again in the background; the dub's files update when that finishes. */
  edit(dubId: string, params: EditLinesParams, options?: RequestOptions): Promise<LinesEdited> {
    return this.#client.request(
      {
        method: "POST",
        path: `/dubs/${encodeURIComponent(dubId)}/lines/edit`,
        body: params,
        retry: "unsafe",
      },
      options,
    );
  }
}

/** Requests for changes to dubs. Early access. */
export class Runs {
  readonly #client: Reedapt;

  constructor(client: Reedapt) {
    this.#client = client;
  }

  retrieve(runId: string, options?: RequestOptions): Promise<Run> {
    return this.#client.request(
      { method: "GET", path: `/runs/${encodeURIComponent(runId)}`, retry: "safe" },
      options,
    );
  }

  /** Answers a run that is `needs_input`: `apply` the proposal or `decline` it. */
  answer(runId: string, params: AnswerRunParams, options?: RequestOptions): Promise<Run> {
    return this.#client.request(
      {
        method: "POST",
        path: `/runs/${encodeURIComponent(runId)}/answer`,
        body: params,
        retry: "unsafe",
      },
      options,
    );
  }
}

export class Dubs {
  readonly #client: Reedapt;
  /** Ask Reedapt for changes to a finished dub. Early access. */
  readonly requests: DubRequests;
  /** Read and edit a dub's lines. Early access. */
  readonly lines: DubLinesResource;

  constructor(client: Reedapt) {
    this.#client = client;
    this.requests = new DubRequests(client);
    this.lines = new DubLinesResource(client);
  }

  /** Starts one dub per target language. Languages that can't start come back in `refused`. */
  create(params: CreateDubsParams, options?: RequestOptions): Promise<DubsCreated> {
    return this.#client.request(
      { method: "POST", path: "/dubs", body: params, retry: "safe", idempotent: true },
      options,
    );
  }

  retrieve(dubId: string, options?: RequestOptions): Promise<Dub> {
    return this.#client.request(
      { method: "GET", path: `/dubs/${encodeURIComponent(dubId)}`, retry: "safe" },
      options,
    );
  }

  /** One page of the account's dubs, newest first. */
  list(params: ListDubsParams = {}, options?: RequestOptions): Promise<DubList> {
    return this.#client.request(
      { method: "GET", path: "/dubs", query: { ...params }, retry: "safe" },
      options,
    );
  }

  /** Every dub, newest first, fetching pages as you go: `for await (const dub of reedapt.dubs.listAll())`. */
  async *listAll(params: Omit<ListDubsParams, "offset"> = {}, options?: RequestOptions): AsyncGenerator<Dub> {
    const limit = params.limit ?? 100;
    const seen = new Set<string>();
    for (let offset = 0; ; offset += limit) {
      const page = await this.list({ limit, offset }, options);
      for (const dub of page.data) {
        // Dubs started while paging shift later pages by one; skip the repeats.
        if (seen.has(dub.id)) continue;
        seen.add(dub.id);
        yield dub;
      }
      if (!page.has_more || page.data.length === 0) return;
    }
  }

  /** Stops an unfinished dub and deletes it. Its minutes are returned. */
  async cancel(dubId: string, options?: RequestOptions): Promise<void> {
    await this.#client.request(
      { method: "POST", path: `/dubs/${encodeURIComponent(dubId)}/cancel`, retry: "safe" },
      options,
    );
  }

  /** Download links for a completed dub's files. Each link lasts an hour. */
  files(dubId: string, options?: RequestOptions): Promise<DubFiles> {
    return this.#client.request(
      { method: "GET", path: `/dubs/${encodeURIComponent(dubId)}/files`, retry: "safe" },
      options,
    );
  }

  /** Every line of a completed dub with its timing, speaker, original words and translation. */
  transcript(dubId: string, options?: RequestOptions): Promise<Transcript> {
    return this.#client.request(
      { method: "GET", path: `/dubs/${encodeURIComponent(dubId)}/transcript`, retry: "safe" },
      options,
    );
  }

  /**
   * Reedapt's check of a finished dub: what it listened to, what it fixed and
   * the lines left for you to review. `checked` is false until the check has run;
   * the `dub.checked` webhook announces it.
   */
  quality(dubId: string, options?: RequestOptions): Promise<Quality> {
    return this.#client.request(
      { method: "GET", path: `/dubs/${encodeURIComponent(dubId)}/quality`, retry: "safe" },
      options,
    );
  }

  /** A completed dub's subtitles as SRT or WebVTT text. */
  subtitles(dubId: string, params: SubtitlesParams = {}, options?: RequestOptions): Promise<string> {
    return this.#client.request(
      {
        method: "GET",
        path: `/dubs/${encodeURIComponent(dubId)}/subtitles`,
        query: { ...params },
        retry: "safe",
        text: true,
      },
      options,
    );
  }

  /**
   * Polls a dub until it is `completed` or `failed` and returns it. Check
   * `status` on the result. Webhooks are better for anything long-running.
   */
  async waitUntilDone(dubId: string, options: WaitForDubOptions = {}): Promise<Dub> {
    const pollInterval = options.pollInterval ?? 30_000;
    const deadline = Date.now() + (options.timeout ?? 12 * 60 * 60 * 1000);
    for (;;) {
      const dub = await this.retrieve(dubId, { signal: options.signal });
      options.onUpdate?.(dub);
      if (dub.status === "completed" || dub.status === "failed") return dub;
      if (Date.now() + pollInterval > deadline) {
        throw new WaitError(`Dub ${dubId} was still ${dub.status} when the wait ran out.`);
      }
      await sleep(pollInterval, options.signal);
    }
  }
}
