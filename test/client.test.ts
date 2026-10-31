import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AuthenticationError,
  ConflictError,
  ConnectionError,
  InvalidRequestError,
  RateLimitError,
  Reedapt,
  ReedaptError,
  ServerError,
  TimeoutError,
} from "../src/index.ts";
import { apiError, json, mockFetch } from "./helpers.ts";

const DUB = { id: "job_1", status: "queued", progress: 0, audio: false, test: true, created_at: "x" };

function client(fetch: typeof globalThis.fetch, extra = {}) {
  return new Reedapt({ apiKey: "rk_test_abc", fetch, maxRetries: 2, ...extra });
}

test("refuses to start without a key", () => {
  const before = process.env.REEDAPT_API_KEY;
  delete process.env.REEDAPT_API_KEY;
  try {
    assert.throws(() => new Reedapt(), ReedaptError);
  } finally {
    if (before !== undefined) process.env.REEDAPT_API_KEY = before;
  }
});

test("reads the key and base URL from the environment", async () => {
  process.env.REEDAPT_API_KEY = "rk_test_env";
  process.env.REEDAPT_BASE_URL = "https://example.test/v1/";
  try {
    const { fetch, calls } = mockFetch(() => json(200, { target_languages: ["fr"] }));
    await new Reedapt({ fetch }).languages.list();
    assert.equal(calls[0].url, "https://example.test/v1/languages");
    assert.equal(calls[0].headers.authorization, "Bearer rk_test_env");
  } finally {
    delete process.env.REEDAPT_API_KEY;
    delete process.env.REEDAPT_BASE_URL;
  }
});

test("sends the key, a user agent and JSON", async () => {
  const { fetch, calls } = mockFetch(() => json(201, { dubs: [DUB], refused: [] }));
  const created = await client(fetch).dubs.create({
    upload_id: "job_1",
    source_language: "en",
    target_languages: ["fr"],
  });
  assert.equal(created.dubs[0].id, "job_1");
  const call = calls[0];
  assert.equal(call.method, "POST");
  assert.equal(call.url, "https://api.reedapt.com/v1/dubs");
  assert.equal(call.headers.authorization, "Bearer rk_test_abc");
  assert.match(call.headers["user-agent"], /^reedapt-node\//);
  assert.equal(call.headers["content-type"], "application/json");
  assert.deepEqual(call.body, { upload_id: "job_1", source_language: "en", target_languages: ["fr"] });
});

test("creating dubs carries an idempotency key, the same on every retry", async () => {
  let n = 0;
  const { fetch, calls } = mockFetch(() => (n++ === 0 ? apiError(500, "INTERNAL") : json(201, { dubs: [] })));
  await client(fetch).dubs.create({ upload_id: "u", source_language: "en", target_languages: ["fr"] });
  assert.equal(calls.length, 2);
  const key = calls[0].headers["idempotency-key"];
  assert.ok(key && key.length > 10);
  assert.equal(calls[1].headers["idempotency-key"], key);
});

test("a caller's idempotency key is used as given", async () => {
  const { fetch, calls } = mockFetch(() => json(201, { dubs: [] }));
  await client(fetch).dubs.create(
    { upload_id: "u", source_language: "en", target_languages: ["fr"] },
    { idempotencyKey: "order-1042" },
  );
  assert.equal(calls[0].headers["idempotency-key"], "order-1042");
});

test("errors carry the status, code and request id, as the right class", async () => {
  const { fetch } = mockFetch(() => apiError(401, "UNAUTHORIZED"));
  const error = await client(fetch).usage.retrieve().catch((e) => e);
  assert.ok(error instanceof AuthenticationError);
  assert.equal(error.status, 401);
  assert.equal(error.code, "UNAUTHORIZED");
  assert.equal(error.requestId, "req_test");
  assert.match(error.message, /^UNAUTHORIZED: /);
});

test("validation errors list their fields", async () => {
  const { fetch } = mockFetch(() =>
    json(422, {
      error: {
        code: "INVALID_REQUEST",
        message: "Some fields are missing or invalid.",
        request_id: "req_1",
        fields: [{ field: "target_languages", message: "Field required" }],
      },
    }),
  );
  const error = await client(fetch)
    .dubs.create({ upload_id: "u", source_language: "en", target_languages: [] })
    .catch((e) => e);
  assert.ok(error instanceof InvalidRequestError);
  assert.equal(error.fields?.[0].field, "target_languages");
});

test("a 422 is not retried", async () => {
  const { fetch, calls } = mockFetch(() => apiError(422, "NOT_ENOUGH_MINUTES"));
  await assert.rejects(
    client(fetch).dubs.create({ upload_id: "u", source_language: "en", target_languages: ["fr"] }),
    InvalidRequestError,
  );
  assert.equal(calls.length, 1);
});

test("a rate limit waits for Retry-After, then retries", async () => {
  let n = 0;
  const { fetch, calls } = mockFetch(() =>
    n++ === 0 ? apiError(429, "RATE_LIMITED", { "retry-after": "0" }) : json(200, { target_languages: [] }),
  );
  await client(fetch).languages.list();
  assert.equal(calls.length, 2);
});

test("limits that last longer than a minute are not retried", async () => {
  const { fetch, calls } = mockFetch(() => apiError(429, "TOO_MANY_DUBS_RUNNING", { "retry-after": "0" }));
  const error = await client(fetch)
    .dubs.create({ upload_id: "u", source_language: "en", target_languages: ["fr"] })
    .catch((e) => e);
  assert.ok(error instanceof RateLimitError);
  assert.equal(error.retryAfter, 0);
  assert.equal(calls.length, 1);
});

test("server errors are retried up to maxRetries, then thrown", async () => {
  const { fetch, calls } = mockFetch(() => apiError(502, "BAD_GATEWAY"));
  await assert.rejects(client(fetch, { maxRetries: 1 }).languages.list(), ServerError);
  assert.equal(calls.length, 2);
});

test("a network failure is retried for safe requests", async () => {
  let n = 0;
  const { fetch, calls } = mockFetch(() => {
    if (n++ === 0) throw new TypeError("fetch failed");
    return json(200, { target_languages: [] });
  });
  await client(fetch).languages.list();
  assert.equal(calls.length, 2);
});

test("adding a webhook endpoint is not retried after a network failure", async () => {
  const { fetch, calls } = mockFetch(() => {
    throw new TypeError("fetch failed");
  });
  await assert.rejects(
    client(fetch).webhookEndpoints.create({ url: "https://example.com/hook" }),
    ConnectionError,
  );
  assert.equal(calls.length, 1);
});

test("a request that takes too long times out", async () => {
  const fetch = ((_: unknown, init: RequestInit) =>
    new Promise((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })) as typeof globalThis.fetch;
  await assert.rejects(client(fetch, { timeout: 20, maxRetries: 0 }).languages.list(), TimeoutError);
});

test("the caller's abort signal stops the request without retrying", async () => {
  const controller = new AbortController();
  let calls = 0;
  const fetch = ((_: unknown, init: RequestInit) => {
    calls++;
    return new Promise((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
  }) as typeof globalThis.fetch;
  const pending = client(fetch).languages.list({ signal: controller.signal });
  controller.abort(new Error("stop"));
  await assert.rejects(pending, /stop/);
  assert.equal(calls, 1);
});

test("cancel and delete return nothing on 204", async () => {
  const { fetch, calls } = mockFetch(() => new Response(null, { status: 204 }));
  const reedapt = client(fetch);
  assert.equal(await reedapt.dubs.cancel("job_1"), undefined);
  assert.equal(await reedapt.webhookEndpoints.delete("we_1"), undefined);
  assert.equal(calls[0].url, "https://api.reedapt.com/v1/dubs/job_1/cancel");
  assert.equal(calls[1].method, "DELETE");
});

test("listAll walks every page and skips repeats", async () => {
  const pages: Record<string, unknown> = {
    "0": { data: [{ ...DUB, id: "a" }, { ...DUB, id: "b" }], has_more: true },
    "2": { data: [{ ...DUB, id: "b" }, { ...DUB, id: "c" }], has_more: false },
  };
  const { fetch, calls } = mockFetch((call) => json(200, pages[new URL(call.url).searchParams.get("offset")!]));
  const ids: string[] = [];
  for await (const dub of client(fetch).dubs.listAll({ limit: 2 })) ids.push(dub.id);
  assert.deepEqual(ids, ["a", "b", "c"]);
  assert.equal(new URL(calls[0].url).searchParams.get("limit"), "2");
});

test("waitUntilDone polls until the dub is final", async () => {
  const statuses = ["queued", "processing", "completed"];
  const { fetch } = mockFetch(() => json(200, { ...DUB, status: statuses.shift() }));
  const seen: string[] = [];
  const dub = await client(fetch).dubs.waitUntilDone("job_1", {
    pollInterval: 1,
    onUpdate: (d) => seen.push(d.status),
  });
  assert.equal(dub.status, "completed");
  assert.deepEqual(seen, ["queued", "processing", "completed"]);
});

test("usage.report asks for the month given", async () => {
  const { fetch, calls } = mockFetch(() => json(200, { month: "2026-09", minutes: 1, keys: [], languages: [] }));
  const report = await client(fetch).usage.report({ month: "2026-09" });
  assert.equal(report.month, "2026-09");
  assert.equal(calls[0].url, "https://api.reedapt.com/v1/usage/report?month=2026-09");
  await client(fetch).usage.report();
  assert.equal(calls[1].url, "https://api.reedapt.com/v1/usage/report");
});

test("dubs.transcript returns the lines", async () => {
  const line = { start_ms: 1200, end_ms: 3850, speaker: "SPEAKER_00", original_text: "Hi.", text: "Salut." };
  const { fetch, calls } = mockFetch(() => json(200, { dub_id: "job_1", lines: [line] }));
  const transcript = await client(fetch).dubs.transcript("job_1");
  assert.deepEqual(transcript.lines, [line]);
  assert.equal(calls[0].url, "https://api.reedapt.com/v1/dubs/job_1/transcript");
});

test("dubs.subtitles returns the file's text", async () => {
  const vtt = "WEBVTT\n\n00:00:01.200 --> 00:00:03.850\nSalut.\n";
  const { fetch, calls } = mockFetch(
    () => new Response(vtt, { status: 200, headers: { "content-type": "text/vtt; charset=utf-8" } }),
  );
  assert.equal(await client(fetch).dubs.subtitles("job_1", { format: "vtt", language: "source" }), vtt);
  assert.equal(calls[0].url, "https://api.reedapt.com/v1/dubs/job_1/subtitles?format=vtt&language=source");
  await client(fetch).dubs.subtitles("job_1");
  assert.equal(calls[1].url, "https://api.reedapt.com/v1/dubs/job_1/subtitles");
});

test("subtitles of an unfinished dub throw a ConflictError", async () => {
  const { fetch } = mockFetch(() => apiError(409, "DUB_NOT_READY"));
  await assert.rejects(client(fetch).dubs.subtitles("job_1"), (e: ConflictError) => {
    assert.ok(e instanceof ConflictError);
    assert.equal(e.code, "DUB_NOT_READY");
    return true;
  });
});

test("resending a delivery posts once and is not retried after a network failure", async () => {
  const delivery = { id: "whd_1", event_id: "evt_1", event_type: "dub.completed", status: "pending", attempts: 0, created_at: "x" };
  const ok = mockFetch(() => json(201, delivery));
  assert.deepEqual(await client(ok.fetch).webhookEndpoints.resendDelivery("we_1", "whd_1"), delivery);
  assert.equal(ok.calls[0].method, "POST");
  assert.equal(ok.calls[0].url, "https://api.reedapt.com/v1/webhook_endpoints/we_1/deliveries/whd_1/resend");

  const down = mockFetch(() => {
    throw new TypeError("fetch failed");
  });
  await assert.rejects(client(down.fetch).webhookEndpoints.resendDelivery("we_1", "whd_1"), ConnectionError);
  assert.equal(down.calls.length, 1);
});
