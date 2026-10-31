import { sleep, type Reedapt, type RequestOptions } from "../client.ts";
import { WaitError } from "../errors.ts";
import type {
  CreateDubsParams,
  Dub,
  DubFiles,
  DubList,
  DubsCreated,
  ListDubsParams,
  SubtitlesParams,
  Transcript,
} from "../types.ts";
import type { WaitOptions } from "./uploads.ts";

export interface WaitForDubOptions extends WaitOptions {
  /** Called after each check, for example to show progress. */
  onUpdate?: (dub: Dub) => void;
}

export class Dubs {
  readonly #client: Reedapt;

  constructor(client: Reedapt) {
    this.#client = client;
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
