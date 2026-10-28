export interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  bytes?: number;
}

type Handler = (call: Call) => Response | Promise<Response>;

/** A fetch that records each call and answers from `handler`. */
export function mockFetch(handler: Handler) {
  const calls: Call[] = [];
  const fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, name) => (headers[name] = value));
    let body: unknown;
    let bytes: number | undefined;
    if (typeof init.body === "string") body = JSON.parse(init.body);
    else if (init.body instanceof Uint8Array) bytes = init.body.byteLength;
    const call = { method: init.method ?? "GET", url: String(input), headers, body, bytes };
    calls.push(call);
    return handler(call);
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function apiError(status: number, code: string, headers: Record<string, string> = {}): Response {
  return json(status, { error: { code, message: `${code} happened`, request_id: "req_test" } }, headers);
}
