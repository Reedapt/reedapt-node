# Reedapt Node.js library

The official Node.js library for the [Reedapt API](https://docs.reedapt.com). Upload video or audio, dub it into other languages in each speaker's own voice, and get the files back.

## Install

```bash
npm install reedapt
```

Node.js 18 or later. It has no dependencies and ships ES modules, CommonJS and TypeScript types.

## Quickstart

Make a key under **Developers** in [Reedapt](https://dub.reedapt.com/developers) and keep it in `REEDAPT_API_KEY`. Test keys are free and dub the first 60 seconds with a watermark.

```ts
import Reedapt from "reedapt";

const reedapt = new Reedapt(); // reads REEDAPT_API_KEY

const { dubs, refused } = await reedapt.dub("./interview.mp4", {
  source_language: "en",
  target_languages: ["fr", "es"],
});

for (const started of dubs) {
  const dub = await reedapt.dubs.waitUntilDone(started.id);
  if (dub.status === "completed") {
    const { files } = await reedapt.dubs.files(dub.id);
    console.log(dub.target_language, files[0].url);
  } else {
    console.log(dub.target_language, "failed:", dub.error?.message);
  }
}
```

`dub()` takes a path, a `Buffer` or `Uint8Array` (with `filename`), a `Blob` or `File`, or a public `https://` link that Reedapt downloads itself. In production, use [webhooks](#webhooks) instead of `waitUntilDone`.

## Uploads

`uploads.uploadFile` sends the file straight to storage in parts, four at a time, signs more links as it needs them, and retries parts that fail:

```ts
const upload = await reedapt.uploads.uploadFile("./film.mov", {
  concurrency: 4,
  onProgress: ({ uploadedBytes, totalBytes }) => console.log(Math.round((100 * uploadedBytes) / totalBytes) + "%"),
});

const created = await reedapt.dubs.create({
  upload_id: upload.id,
  source_language: "en",
  target_languages: ["yo"],
  metadata: { order_id: "1042" },
  instructions: "Keep the speaker's name, Adaeze, as it is. Warm, informal tone.", // paid plans
});
```

For a file that's already online:

```ts
const upload = await reedapt.uploads.fromUrl("https://example.com/media/talk.mp4");
```

## Dubs

```ts
await reedapt.dubs.retrieve("job_3f9a2c7e1b4d");
await reedapt.dubs.list({ limit: 20 });
for await (const dub of reedapt.dubs.listAll()) console.log(dub.id, dub.status);
await reedapt.dubs.files("job_3f9a2c7e1b4d"); // links last an hour
await reedapt.dubs.cancel("job_3f9a2c7e1b4d"); // minutes are returned
await reedapt.dubs.transcript("job_3f9a2c7e1b4d"); // every line, with timing, speaker and translation
await reedapt.dubs.subtitles("job_3f9a2c7e1b4d", { format: "vtt" }); // SRT (default) or WebVTT text
await reedapt.dubs.quality("job_3f9a2c7e1b4d"); // Reedapt's check: lines fixed and lines left to review

await reedapt.languages.list(); // { target_languages: [...] }
await reedapt.usage.retrieve(); // plan, key mode and minutes left
await reedapt.usage.report({ month: "2026-10" }); // minutes and dubs per key and per language
```

## Ask Reedapt for changes

Early access: this is released to some paid accounts first, and other accounts get a `403` with the code `NOT_AVAILABLE`. Describe a change in plain words and Reedapt either answers, proposes a change, or makes it. With `autonomy: "ask"` (the default) nothing changes until you say so:

```ts
let run = await reedapt.dubs.requests.create("job_3f9a2c7e1b4d", {
  text: "Is line 3 natural? If not, make it sound calmer.",
  autonomy: "ask",
});
console.log(run.reply);

if (run.status === "needs_input") {
  console.log(run.proposal?.summary, run.proposal?.lines); // lines = how many it would change
  run = await reedapt.runs.answer(run.id, { choice: "apply" }); // or "decline"
}
// run.status is done, applied, declined or failed; run.applied_lines counts the lines changed.
await reedapt.runs.retrieve(run.id);
```

You can also read and edit lines yourself. Edited lines are voiced again in the background:

```ts
const { lines } = await reedapt.dubs.lines.list("job_3f9a2c7e1b4d");
await reedapt.dubs.lines.edit("job_3f9a2c7e1b4d", {
  lines: [{ line: 3, text: "Bienvenue chez nous.", delivery_style: "warm" }],
}); // { dub_id, lines: [3], status: "revoicing" }
```

A request counts against your plan's allowance for these requests; when it's used up you get `AGENT_ALLOWANCE_USED` (429) until it renews.

## Webhooks

Add an endpoint under **Developers**, or with `reedapt.webhookEndpoints.create({ url })`, and keep its `whsec_` secret. `reedapt.webhookEndpoints.resendDelivery(endpointId, deliveryId)` sends a past delivery again. Check every delivery against the raw body:

```ts
import express from "express";
import { constructWebhookEvent, WebhookVerificationError } from "reedapt";

const app = express();

app.post("/reedapt/webhooks", express.raw({ type: "application/json" }), (req, res) => {
  let event;
  try {
    event = constructWebhookEvent(req.body, req.get("Reedapt-Signature"), process.env.REEDAPT_WEBHOOK_SECRET!);
  } catch (e) {
    if (e instanceof WebhookVerificationError) return res.sendStatus(400);
    throw e;
  }
  if (event.type === "dub.completed") {
    // event.data.dub is the finished dub. Queue the work, then answer quickly.
  } else if (event.type === "dub.checked") {
    // A few minutes later, on plans where Reedapt checks dubs:
    // event.data.quality lists the lines it fixed and the ones left to review.
  } // Ignore types you don't know; every endpoint gets every event.
  res.sendStatus(200);
});
```

An event can arrive more than once, so skip any `event.id` you've already handled.

## Errors

Failed requests throw a subclass of `APIError` with the HTTP `status`, a stable `code`, a plain-English `message` and the `requestId` to quote to support:

```ts
import { APIError, RateLimitError } from "reedapt";

try {
  await reedapt.dubs.create({ upload_id, source_language: "en", target_languages: ["fr"] });
} catch (e) {
  if (e instanceof RateLimitError && e.code === "TOO_MANY_DUBS_RUNNING") {
    // Start more once some finish.
  } else if (e instanceof APIError) {
    console.error(e.status, e.code, e.message, e.requestId);
  } else {
    throw e;
  }
}
```

| Class | When |
| --- | --- |
| `AuthenticationError` | 401: the key is missing, wrong or revoked. |
| `NotFoundError` | 404 |
| `ConflictError` | 409: the object isn't in a state that allows this. |
| `InvalidRequestError` | 400, 411, 413, 422. `fields` lists invalid fields. |
| `RateLimitError` | 429. `retryAfter` is in seconds. |
| `ServerError` | 5xx |
| `ConnectionError`, `TimeoutError` | No answer arrived. |
| `UploadError` | A part couldn't be sent to storage. |
| `WaitError` | A `waitUntil…` helper ran out of time, or the upload failed. |
| `WebhookVerificationError` | A delivery's signature didn't check out. |

The [error codes](https://docs.reedapt.com/errors) are listed in the docs.

## Retries and repeated requests

Network failures, `500`, `502`, `503`, `504` and per-minute rate limits are retried twice, with backoff, honouring `Retry-After`. Creating uploads and dubs always sends an `Idempotency-Key`, so a retry never makes a second dub. Pass your own to make a repeat safe across restarts:

```ts
await reedapt.dubs.create(params, { idempotencyKey: `order-${order.id}` });
```

## Configuration

```ts
const reedapt = new Reedapt({
  apiKey: process.env.REEDAPT_API_KEY,
  timeout: 60_000, // per request, in milliseconds
  maxRetries: 2,
});

await reedapt.dubs.retrieve(id, { timeout: 10_000, maxRetries: 0, signal: AbortSignal.timeout(15_000) });
```

Keep keys on your server. Never put one in a web page or an app people can download.

## Links

- [Documentation](https://docs.reedapt.com)
- [API reference](https://docs.reedapt.com/api-reference/introduction)
- [Status](https://status.reedapt.com)
- Support: support@reedapt.com
