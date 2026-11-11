/**
 * PMS provider port (Plan 7 Task 2). NO live implementation ships in this plan — Ruling H: the
 * OHIP (OPERA Cloud) documentation is internally inconsistent (two incompatible reservation
 * endpoints; a charge body missing a field another file calls mandatory; the `noPost` flag this
 * design depends on unfindable under any name), and OPERA cannot be smoke-tested without a real
 * customer property. So the port + `MockPmsProvider` fully specify the contract, every flow is
 * proven against the mock, and the live adapter is an external gate needing OHIP credentials.
 * When it lands, it is constructed in `registry.ts` (hotel identity — `venue.pms.hotelId` — is
 * CONSTRUCTOR config, mirroring `ToastPos`'s `restaurantGuid`, not a per-call parameter).
 *
 * `reservationRef` and `postingRef` are OPAQUE, ADAPTER-OWNED strings (Ruling X — the same three
 * rules `posCheckRefSchema` carries): adapter-minted, adapter-parsed, no caller may interpret
 * one, and an adapter MUST reject a ref it did not mint rather than guess. Deliberately NO format
 * (e.g. `{folioId}:{chargeId}`) is documented here — that would commit to the UNVERIFIED folio
 * model; the convention is committed, the format is the future adapter's private business.
 */
export interface PmsReservation {
  reservationRef: string;
  guestName: string;
  room: string;
  /**
   * ISO dates when the provider supplies them. NOT exposed by `pmsLookup`'s contract output
   * (0.4.x carries only reservationRef/guestName/room/noPost) — they exist on the port because
   * the hotel portal's arrivals/departures view is specified to group by them, which needs a
   * contracts addition before it can be built (flagged in task-2-platform-report.md, not taken).
   */
  arrival?: string | undefined;
  departure?: string | undefined;
  /** The folio refuses charges (cash-only stay, card on file declined, etc.). */
  noPost: boolean;
}

export interface PmsProvider {
  /** Reservations matching a guest-name and/or room filter. At least one filter is the CALLER's job to require. */
  lookupReservation(i: { name?: string | undefined; room?: string | undefined }): Promise<{ reservations: PmsReservation[] }>;
  /**
   * Posts one charge to the reservation's folio. Integer cents (`amount`); `referenceId` is the
   * caller's deterministic idempotency key (the ticket id) so a real provider that dedupes by
   * reference can refuse a double-post server-side too. A provider MUST reject a `noPost`
   * reservation even though callers check first — defense in depth on a money write.
   */
  postCharge(i: { reservationRef: string; amount: number; currency: string; chargeCode: string; description: string; referenceId: string }): Promise<{ postingRef: string }>;
  /**
   * Reverses a previously posted charge. `postingRef` must be one this adapter minted.
   *
   * CONTRACT (T2/T3 fix round L2), part of the port, not a convention: an adapter MUST be
   * idempotent per `referenceId` — reversing an already-reversed posting with the SAME
   * `referenceId` is a success no-op (the caller's crash-retry window: reversal succeeded, its
   * marker write did not), while a DIFFERENT `referenceId` against an already-reversed posting
   * MUST still throw (a genuine double-reverse bug stays loud). Handlers rely on this instead of
   * treating a whole provider error class as success, which would swallow real failures.
   */
  reverseCharge(i: { postingRef: string; referenceId: string }): Promise<void>;
  healthCheck(): Promise<{ ok: boolean; message?: string }>;
}
