import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Reedapt, UploadError, WaitError } from "../src/index.ts";
import { apiError, json, mockFetch, type Call } from "./helpers.ts";

const STORAGE = "https://storage.test/";

/** A fake API plus storage for one upload of `size` bytes in parts of `partSize`. */
function fakeUploadServer(size: number, partSize: number, options: { firstLinks?: number; storage?: (call: Call) => Response | undefined } = {}) {
  const partCount = Math.ceil(size / partSize);
  const firstLinks = Math.min(options.firstLinks ?? 100, partCount);
  const link = (n: number) => ({ part_number: n, url: `${STORAGE}part/${n}` });
  const upload = { id: "job_up", filename: "talk.mp4", size, part_size: partSize, part_count: partCount };
  return mockFetch((call) => {
    const path = call.url.replace("https://api.reedapt.com/v1", "");
    if (call.url.startsWith(STORAGE)) {
      const custom = options.storage?.(call);
      if (custom) return custom;
      return new Response(null, { status: 200, headers: { etag: `"etag-${call.url.split("/").pop()}"` } });
    }
    if (path === "/uploads") {
      return json(201, {
        ...upload,
        status: "uploading",
        parts: Array.from({ length: firstLinks }, (_, i) => link(i + 1)),
      });
    }
    if (path === "/uploads/job_up/parts") {
      return json(200, { parts: (call.body as { part_numbers: number[] }).part_numbers.map(link) });
    }
    if (path === "/uploads/job_up/complete") return json(200, { ...upload, status: "uploaded" });
    if (path === "/uploads/job_up") return json(200, { ...upload, status: "uploaded" });
    return apiError(404, "NOT_FOUND");
  });
}

test("uploads bytes in parts and completes with every ETag in order", async () => {
  const { fetch, calls } = fakeUploadServer(10, 4);
  const progress: number[] = [];
  const upload = await new Reedapt({ apiKey: "rk_test_x", fetch }).uploads.uploadFile(new Uint8Array(10), {
    filename: "talk.mp4",
    onProgress: (p) => progress.push(p.uploadedBytes),
  });
  assert.equal(upload.status, "uploaded");
  assert.deepEqual(calls[0].body, { filename: "talk.mp4", size: 10 });
  assert.ok(calls[0].headers["idempotency-key"]);
  const puts = calls.filter((c) => c.method === "PUT");
  assert.deepEqual(puts.map((c) => c.bytes).sort(), [2, 4, 4]);
  for (const put of puts) assert.equal(put.headers.authorization, undefined, "no API key on storage links");
  const complete = calls.find((c) => c.url.endsWith("/complete"))!;
  assert.deepEqual(complete.body, {
    parts: [
      { part_number: 1, etag: '"etag-1"' },
      { part_number: 2, etag: '"etag-2"' },
      { part_number: 3, etag: '"etag-3"' },
    ],
  });
  assert.equal(progress.at(-1), 10);
});

test("uploads a file from disk, named after the file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "reedapt-"));
  try {
    const path = join(dir, "sermon.mp3");
    await writeFile(path, Buffer.alloc(9, 7));
    const { fetch, calls } = fakeUploadServer(9, 4);
    await new Reedapt({ apiKey: "rk_test_x", fetch }).uploads.uploadFile(path);
    assert.deepEqual(calls[0].body, { filename: "sermon.mp3", size: 9 });
    assert.equal(calls.filter((c) => c.method === "PUT").reduce((sum, c) => sum + c.bytes!, 0), 9);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("signs the parts the first answer didn't include, a batch at a time", async () => {
  const { fetch, calls } = fakeUploadServer(250, 1, { firstLinks: 100 });
  await new Reedapt({ apiKey: "rk_test_x", fetch }).uploads.uploadFile(new Uint8Array(250), {
    filename: "a.mp4",
    concurrency: 8,
  });
  const signs = calls.filter((c) => c.url.endsWith("/parts")).map((c) => (c.body as { part_numbers: number[] }).part_numbers);
  assert.equal(signs.length, 2);
  assert.deepEqual([signs[0][0], signs[0].at(-1), signs[1][0], signs[1].at(-1)], [101, 200, 201, 250]);
  assert.equal(calls.filter((c) => c.method === "PUT").length, 250);
});

test("an expired link is signed again and the part resent", async () => {
  let refused = false;
  const { fetch, calls } = fakeUploadServer(8, 4, {
    storage: (call) => {
      if (call.url.endsWith("/2") && !refused) {
        refused = true;
        return new Response("<Error>Request has expired</Error>", { status: 403 });
      }
      return undefined;
    },
  });
  const upload = await new Reedapt({ apiKey: "rk_test_x", fetch }).uploads.uploadFile(new Uint8Array(8), {
    filename: "a.mp4",
  });
  assert.equal(upload.status, "uploaded");
  const resign = calls.find((c) => c.url.endsWith("/parts"));
  assert.deepEqual(resign?.body, { part_numbers: [2] });
});

test("a part that keeps failing stops the upload", async () => {
  const { fetch, calls } = fakeUploadServer(8, 4, {
    storage: (call) => (call.url.endsWith("/1") ? new Response("no", { status: 500 }) : undefined),
  });
  await assert.rejects(
    new Reedapt({ apiKey: "rk_test_x", fetch }).uploads.uploadFile(new Uint8Array(8), { filename: "a.mp4", concurrency: 1 }),
    UploadError,
  );
  assert.equal(calls.some((c) => c.url.endsWith("/complete")), false);
});

test("bytes need a filename", async () => {
  const { fetch } = fakeUploadServer(1, 1);
  await assert.rejects(new Reedapt({ apiKey: "rk_test_x", fetch }).uploads.uploadFile(new Uint8Array(1)), UploadError);
});

test("fromUrl waits until the download is done", async () => {
  const statuses = ["fetching", "uploaded"];
  const { fetch, calls } = mockFetch((call) =>
    call.method === "POST"
      ? json(202, { id: "job_u", status: "fetching", filename: "", size: 0, part_size: 0, part_count: 0 })
      : json(200, { id: "job_u", status: statuses.shift(), filename: "a.mp4", size: 5, part_size: 0, part_count: 0 }),
  );
  const upload = await new Reedapt({ apiKey: "rk_test_x", fetch }).uploads.fromUrl("https://example.com/a.mp4", {
    pollInterval: 1,
  });
  assert.equal(upload.status, "uploaded");
  assert.deepEqual(calls[0].body, { source_url: "https://example.com/a.mp4" });
  assert.equal(calls.length, 3);
});

test("fromUrl throws when the download failed", async () => {
  const { fetch } = mockFetch((call) =>
    json(call.method === "POST" ? 202 : 200, {
      id: "job_u",
      status: call.method === "POST" ? "fetching" : "failed",
      error: "SOURCE_URL_TOO_SLOW",
      filename: "",
      size: 0,
      part_size: 0,
      part_count: 0,
    }),
  );
  await assert.rejects(
    new Reedapt({ apiKey: "rk_test_x", fetch }).uploads.fromUrl("https://example.com/a.mp4", { pollInterval: 1 }),
    (e: unknown) => e instanceof WaitError && /SOURCE_URL_TOO_SLOW/.test(e.message),
  );
});

test("dub() uploads and starts the dubs in one call", async () => {
  const server = fakeUploadServer(4, 4);
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith("/v1/dubs")) return json(201, { dubs: [{ id: "job_d" }], refused: [] });
    return server.fetch(input, init);
  }) as typeof globalThis.fetch;
  const calls: { url: string; body?: unknown; key?: string }[] = [];
  const spy = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(input), key: headers.get("idempotency-key") ?? undefined, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    return fetch(input, init);
  }) as typeof globalThis.fetch;
  const created = await new Reedapt({ apiKey: "rk_test_x", fetch: spy }).dub(new Uint8Array(4), {
    filename: "talk.mp4",
    source_language: "en",
    target_languages: ["fr", "es"],
    idempotencyKey: "order-7",
  });
  assert.equal(created.dubs[0].id, "job_d");
  const dubs = calls.find((c) => c.url.endsWith("/v1/dubs"))!;
  assert.deepEqual(dubs.body, { source_language: "en", target_languages: ["fr", "es"], upload_id: "job_up" });
  assert.equal(dubs.key, "order-7:dubs");
  assert.equal(calls[0].key, "order-7:upload");
});
