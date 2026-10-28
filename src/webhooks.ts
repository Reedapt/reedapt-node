import { createHmac, timingSafeEqual } from "node:crypto";
import { WebhookVerificationError } from "./errors.ts";
import type { WebhookEvent } from "./types.ts";

export interface VerifyOptions {
  /** Oldest signature accepted, in seconds. Defaults to 300. */
  tolerance?: number;
}

type Payload = string | Uint8Array;

/**
 * Checks a delivery's `Reedapt-Signature` header against the raw request body,
 * exactly as it arrived. Throws `WebhookVerificationError` if it doesn't match.
 */
export function verifyWebhook(
  payload: Payload,
  header: string | null | undefined,
  secret: string,
  options: VerifyOptions = {},
): void {
  if (!header) throw new WebhookVerificationError("The Reedapt-Signature header is missing.");
  let timestamp: string | undefined;
  const signatures: string[] = [];
  for (const item of header.split(",")) {
    const at = item.indexOf("=");
    if (at < 0) continue;
    const name = item.slice(0, at).trim();
    const value = item.slice(at + 1).trim();
    if (name === "t") timestamp = value;
    else if (name === "v1") signatures.push(value);
  }
  if (!timestamp || !/^\d+$/.test(timestamp) || signatures.length === 0) {
    throw new WebhookVerificationError("The Reedapt-Signature header is malformed.");
  }
  const tolerance = options.tolerance ?? 300;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > tolerance) {
    throw new WebhookVerificationError("The signature is too old. Check your server's clock.");
  }
  const body = typeof payload === "string" ? Buffer.from(payload, "utf8") : Buffer.from(payload);
  const expected = createHmac("sha256", secret)
    .update(Buffer.concat([Buffer.from(`${timestamp}.`), body]))
    .digest();
  const matches = signatures.some((given) => {
    const bytes = Buffer.from(given, "hex");
    return bytes.length === expected.length && timingSafeEqual(bytes, expected);
  });
  if (!matches) {
    throw new WebhookVerificationError(
      "The signature doesn't match. Use the endpoint's secret and the raw body, not re-encoded JSON.",
    );
  }
}

/** Verifies a delivery and returns its parsed event. */
export function constructWebhookEvent(
  payload: Payload,
  header: string | null | undefined,
  secret: string,
  options?: VerifyOptions,
): WebhookEvent {
  verifyWebhook(payload, header, secret, options);
  const text = typeof payload === "string" ? payload : Buffer.from(payload).toString("utf8");
  return JSON.parse(text) as WebhookEvent;
}

export class Webhooks {
  verify(payload: Payload, header: string | null | undefined, secret: string, options?: VerifyOptions): void {
    verifyWebhook(payload, header, secret, options);
  }

  constructEvent(
    payload: Payload,
    header: string | null | undefined,
    secret: string,
    options?: VerifyOptions,
  ): WebhookEvent {
    return constructWebhookEvent(payload, header, secret, options);
  }
}
