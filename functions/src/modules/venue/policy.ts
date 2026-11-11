/**
 * The venue portal's time policies, together in one place (lead's instruction on Ruling AF:
 * "both time policies sit together and neither is an inline literal").
 */

/**
 * Ruling AE: every validation expires 24 hours after issue. An unbounded code is a standing
 * money exposure — a comp issued today would be redeemable indefinitely and nothing in the
 * system would ever notice. 24h covers the real case (same visit, including an overnight or
 * late pickup); the failure mode of a too-short window is a reissue at the stand (recoverable),
 * while an immortal code isn't.
 */
export const VALIDATION_TTL_MS = 24 * 3600_000;

/**
 * Ruling AF: a pre-arrival ETA up to 30 minutes past venue-local now clamps to NOW; anything
 * further past rolls to the next occurrence (tomorrow). The window exists because the two
 * failure modes are not symmetric: always-rolling a just-passed time parks the card 24 hours
 * out where TONIGHT'S stand never sees it — a silent failure, at the venue, in front of a
 * guest, that nobody involved can diagnose (the host did what the form asked). Clamping a
 * just-passed time merely surfaces the card a few minutes early, which costs nothing. Thirty
 * minutes is wide enough for the real cases (a mistype, a slowly-filled form, a host who
 * glanced at the clock before the guest called) and narrow enough that the genuine next-day
 * case still rolls — someone typing 2pm at 8pm plainly means tomorrow's lunch, five hours
 * past, well outside the window. Do NOT "simplify" the window away: its absence is the silent
 * failure mode above.
 */
export const ETA_PAST_GRACE_MS = 30 * 60_000;
