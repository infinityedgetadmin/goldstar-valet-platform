/**
 * Thrown by a channel's render/validation step for a deterministic producer bug — an unknown
 * `template` name, or a `vars` object that fails its zod schema — as opposed to a transient provider
 * failure (network blip, rate limit, momentary outage). Retrying a PermanentSendError can never
 * succeed: no number of `retryOutboundMessages` re-runs fixes a bad `template` string or a malformed
 * `vars` object, only a code/data fix can. `sendOutboundHandler`'s shared catch (sender.ts) checks for
 * this type and marks the doc `failed` on the very first attempt instead of burning ~15 minutes and 4
 * wasted scheduled-function invocations through the transient-failure backoff cycle first (Task 1
 * review, Finding M3).
 *
 * SMS's `renderTemplate` (templates.ts) structurally cannot throw — an unknown template name falls
 * back to a static default string, a missing var renders as `''` — so this distinction has no SMS
 * precedent to mirror; it's new ground the email channel introduces.
 */
export class PermanentSendError extends Error {}
