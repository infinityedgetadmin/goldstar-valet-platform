/**
 * POS provider port (Plan 7 Task 3). One implementation today (Toast) plus the mock; the port
 * exists so `posApplyValidation`'s live path — Ruling Y's explicitly-unverified call — is built
 * against an interface the mock fully exercises, and so a second POS ever only implements this.
 *
 * `checkRef` is an OPAQUE, ADAPTER-MINTED token (Ruling X's convention, applied to POS by the
 * reconciled §3): the Toast adapter encodes `{orderGuid}:{checkGuid}` because its API needs both
 * halves in the path, but that layout is the adapter's private business — clients round-trip the
 * string and never parse it, and an adapter MUST reject a ref it did not mint rather than guess.
 */
export interface PosCheck {
  checkRef: string;
  table?: string | undefined;
  /** Integer cents. */
  total: number;
  openedAt: string;
}

export interface PosProvider {
  /** Open checks for the venue, optionally narrowed to a table or a single known ref. */
  findCheck(i: { table?: string | undefined; checkRef?: string | undefined }): Promise<{ checks: PosCheck[] }>;
  /**
   * Pushes a validation discount onto an existing check. Integer cents; `reason` is a short
   * operator-facing string (the validation code). RULING Y: for Toast this is the UNVERIFIED
   * call — see the adapter.
   */
  applyValidation(i: { checkRef: string; amount: number; reason: string }): Promise<{ ok: true }>;
  /** Adds the valet charge as a line item on the check. Integer cents. */
  addCharge(i: { checkRef: string; item: { name: string; amount: number } }): Promise<{ ok: true }>;
  healthCheck(): Promise<{ ok: boolean; message?: string }>;
}
