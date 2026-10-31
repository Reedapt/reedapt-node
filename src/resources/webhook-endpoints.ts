import type { Reedapt, RequestOptions } from "../client.ts";
import type {
  CreateWebhookEndpointParams,
  WebhookDelivery,
  WebhookDeliveryList,
  WebhookEndpoint,
  WebhookEndpointList,
} from "../types.ts";

export class WebhookEndpoints {
  readonly #client: Reedapt;

  constructor(client: Reedapt) {
    this.#client = client;
  }

  /** Adds an endpoint. The answer's `secret` is shown only this once. */
  create(params: CreateWebhookEndpointParams, options?: RequestOptions): Promise<WebhookEndpoint> {
    // Not retried after a network failure: it could add the endpoint twice.
    return this.#client.request(
      { method: "POST", path: "/webhook_endpoints", body: params, retry: "unsafe" },
      options,
    );
  }

  list(options?: RequestOptions): Promise<WebhookEndpointList> {
    return this.#client.request({ method: "GET", path: "/webhook_endpoints", retry: "safe" }, options);
  }

  async delete(endpointId: string, options?: RequestOptions): Promise<void> {
    await this.#client.request(
      { method: "DELETE", path: `/webhook_endpoints/${encodeURIComponent(endpointId)}`, retry: "safe" },
      options,
    );
  }

  /** Sends a `webhook.test` event to the endpoint. */
  async sendTest(endpointId: string, options?: RequestOptions): Promise<void> {
    await this.#client.request(
      {
        method: "POST",
        path: `/webhook_endpoints/${encodeURIComponent(endpointId)}/test`,
        retry: "unsafe",
      },
      options,
    );
  }

  /** Recent deliveries to the endpoint, with what it answered. */
  deliveries(
    endpointId: string,
    params: { limit?: number } = {},
    options?: RequestOptions,
  ): Promise<WebhookDeliveryList> {
    return this.#client.request(
      {
        method: "GET",
        path: `/webhook_endpoints/${encodeURIComponent(endpointId)}/deliveries`,
        query: { ...params },
        retry: "safe",
      },
      options,
    );
  }

  /**
   * Sends a past delivery's event to the endpoint again, now. It keeps its event id,
   * so a receiver that skips repeats by event id skips it too.
   */
  resendDelivery(endpointId: string, deliveryId: string, options?: RequestOptions): Promise<WebhookDelivery> {
    return this.#client.request(
      {
        method: "POST",
        path: `/webhook_endpoints/${encodeURIComponent(endpointId)}/deliveries/${encodeURIComponent(deliveryId)}/resend`,
        retry: "unsafe",
      },
      options,
    );
  }
}
