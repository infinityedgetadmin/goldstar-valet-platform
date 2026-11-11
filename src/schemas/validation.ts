import { z } from 'zod';
import { isoDateSchema, moneySchema, uuidSchema } from './common';
export const validationSchema = z.object({
  id: z.string().min(1), operatorId: z.string(), venueId: z.string(), code: z.string().regex(/^[A-Z0-9]{6}$/),
  type: z.enum(['full', 'partial', 'comp', 'rate']),
  /** ISSUE-time amount. Only meaningful for `partial`, where the host names a figure up front. */
  amount: moneySchema.optional(),
  rateId: z.string().optional(),
  issuedBy: z.string(), issuedAt: isoDateSchema, redeemedTicketId: uuidSchema.optional(), expiresAt: isoDateSchema.optional(),
  /**
   * REDEMPTION-time record. A `full` validation's worth CANNOT be known at issue: hourly rates
   * grow between 18:00 and 21:00, and the validation must cover what is owed at pickup. The
   * handler computes the amount when the code is applied and persists both it and the `base` it
   * was computed from, so invoicing can reconstruct the decision after the venue's rates change —
   * without `base`, a later rate edit makes every historical `full` redemption unauditable: you
   * would see what was discounted but never what it was discounted FROM.
   *
   * Ruling S — grouped, not three flat optionals. The three values are only meaningful together,
   * and an amount without its base is exactly the unreconstructable state this field exists to
   * prevent. Inside the object every field is required, so a writer supplies all three or omits
   * the object entirely: the half-populated state is unrepresentable rather than merely
   * discouraged. `redeemedTicketId` stays flat — moving it is the breaking change being avoided.
   */
  redemption: z.object({ amount: moneySchema, base: moneySchema, at: isoDateSchema }).optional(),
});
export type Validation = z.infer<typeof validationSchema>;
