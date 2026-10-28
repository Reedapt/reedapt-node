import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { constructWebhookEvent, Reedapt, verifyWebhook, WebhookVerificationError } from "../src/index.ts";

const SECRET = "whsec_test";
const BODY = JSON.stringify({ id: "evt_1", type: "dub.completed", created_at: "x", data: { dub: { id: "job_1" } } });

function sign(body: string, t = Math.floor(Date.now() / 1000), secret = SECRET) {
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
}

test("a correctly signed delivery verifies and parses", () => {
  const event = constructWebhookEvent(BODY, sign(BODY), SECRET);
  assert.equal(event.type, "dub.completed");
  assert.equal(event.id, "evt_1");
});

test("the raw body can be bytes", () => {
  assert.doesNotThrow(() => verifyWebhook(Buffer.from(BODY), sign(BODY), SECRET));
});

test("the client exposes the same check, without needing a request", () => {
  const reedapt = new Reedapt({ apiKey: "rk_test_x" });
  assert.equal(reedapt.webhooks.constructEvent(BODY, sign(BODY), SECRET).id, "evt_1");
});

test("a changed body is refused", () => {
  assert.throws(() => verifyWebhook(BODY.replace("job_1", "job_2"), sign(BODY), SECRET), WebhookVerificationError);
});

test("re-encoded JSON is refused", () => {
  const reencoded = JSON.stringify(JSON.parse(BODY), null, 2);
  assert.throws(() => verifyWebhook(reencoded, sign(BODY), SECRET), WebhookVerificationError);
});

test("the wrong secret is refused", () => {
  assert.throws(() => verifyWebhook(BODY, sign(BODY, undefined, "whsec_other"), SECRET), WebhookVerificationError);
});

test("an old signature is refused, within a configurable tolerance", () => {
  const old = Math.floor(Date.now() / 1000) - 600;
  assert.throws(() => verifyWebhook(BODY, sign(BODY, old), SECRET), /too old/);
  assert.doesNotThrow(() => verifyWebhook(BODY, sign(BODY, old), SECRET, { tolerance: 900 }));
});

test("a missing or malformed header is refused", () => {
  assert.throws(() => verifyWebhook(BODY, undefined, SECRET), /missing/);
  assert.throws(() => verifyWebhook(BODY, "nonsense", SECRET), /malformed/);
  assert.throws(() => verifyWebhook(BODY, "t=abc,v1=00", SECRET), /malformed/);
});

test("any one of several v1 signatures may match", () => {
  const good = sign(BODY);
  const t = good.split(",")[0];
  assert.doesNotThrow(() => verifyWebhook(BODY, `${t},v1=${"0".repeat(64)},${good.split(",")[1]}`, SECRET));
});
