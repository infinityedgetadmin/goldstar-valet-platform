/** Plan 8 Task 16: hard ceiling for the three public `onRequest` endpoints (Stripe webhook, Twilio
 * status + inbound). Cloud Functions' own limit is far larger; none of these payloads is
 * legitimately more than a few KB, so anything past 1 MiB is either a misdirected request or an
 * attempt to make the handler chew on a large body before signature verification runs. */
export const MAX_REQUEST_BYTES = 1024 * 1024;

/** The slice of Express's request the guard reads — structural so tests pass plain objects. */
export interface SizedRequest {
  get(header: string): string | undefined;
  rawBody?: Buffer | undefined;
}

/** `status().send()` — the same chainable shape `WebhookResponse` already models. */
export interface SizedResponse {
  status(code: number): { send(body: string): unknown };
}

/**
 * Replies `413 payload too large` and returns `true` when either the declared `Content-Length`
 * or the actual buffered body exceeds `max`. Both are checked on purpose: a client can lie in
 * the header (or omit it under chunked encoding), and the framework has already buffered
 * `rawBody` by the time a handler runs, so its length is the ground truth when present.
 */
export function rejectOversized(req: SizedRequest, res: SizedResponse, max: number = MAX_REQUEST_BYTES): boolean {
  const declaredRaw = req.get('content-length');
  const declared = declaredRaw === undefined ? Number.NaN : Number(declaredRaw);
  const actual = req.rawBody?.length ?? 0;
  if ((Number.isFinite(declared) && declared > max) || actual > max) {
    res.status(413).send('payload too large');
    return true;
  }
  return false;
}
