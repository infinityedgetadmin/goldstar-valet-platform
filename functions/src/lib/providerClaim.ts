/**
 * How long a provider-charge/push CLAIM may sit at `status:'pending'` before a retry may take it
 * over. THE shared constant for the three claim state machines that are genuinely identical —
 * `pos/applyValidation.ts` (the validation push), `pos/addCharge.ts` (the check line item), and
 * `pms/roomCharge.ts` (the folio charge). Extracted at the THIRD copy, on the ruling that
 * "extract at the next copy" doesn't happen (the CHARGE_LABELS lesson: three hand-copies, the
 * third found by accident).
 *
 * The rationale, canonical here: a pending claim younger than this is an IN-FLIGHT provider
 * attempt — the double-tap race — and the duplicate call must be refused, not fulfilled; one
 * older is a genuine crash and the retry may take the claim over transactionally. Each guarded
 * attempt is at most TWO abort-capped HTTP calls (toast.adapter.ts's TIMEOUT_MS = 10s each: a
 * login when the module token cache is cold, then the operation; the future OPERA adapter is
 * expected to bound the same way), so 60s is several lifetimes past any legitimate in-flight
 * window.
 *
 * NOT every retry threshold belongs here — same value, one constant; different values, distinct
 * constants that name each other. `scheduling/pushClock.ts`'s `PUSH_CLAIM_TTL_MS` (90s = 3 ×
 * its own THREE-call worst-case chain) is the deliberate non-member with its own derivation —
 * collapsing it into this would derive one bound from the wrong chain. `scheduling/pushClock.ts`'s `REPORT_AFTER_MS` (2min) and
 * `GIVE_UP_AFTER_MS` (1h) are retry-REPORTING thresholds with their own derivations, not claim
 * TTLs; collapsing them into this would couple unrelated policies (the Ruling AL Low-1 lesson).
 */
export const PROVIDER_CLAIM_TTL_MS = 60_000;
