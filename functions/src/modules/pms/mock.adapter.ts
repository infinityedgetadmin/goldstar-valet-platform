import { err } from '../../lib/errors.js';
import type { PmsProvider, PmsReservation } from './port.js';

/**
 * In-memory PMS for tests and for the Ruling H development path — no live OPERA adapter ships in
 * Plan 7 (the OHIP contract could not be verified), so every room-charge flow is proven
 * end-to-end against THIS provider, which the port fully specifies. Reservations are seeded by
 * the constructor (tests load `functions/test/fixtures/pms-mock.json` — mock SEED data invented
 * by us, deliberately NOT a recording of any OHIP response; recording one would freeze an
 * unverified contract, the exact thing Ruling H forbids).
 *
 * Mints its own opaque `postingRef`s (`mock_{n}`) and rejects reservation/posting refs it did not
 * seed/mint — the same contract a real adapter enforces (Ruling X), so a test passing here can't
 * be quietly depending on a parseable ref.
 */
export class MockPmsProvider implements PmsProvider {
  private nextRef = 1;
  private reservations = new Map<string, PmsReservation>();
  /** Test inspection surface: every posting this provider ever accepted, in order. */
  readonly postings: { postingRef: string; reservationRef: string; amount: number; currency: string; chargeCode: string; description: string; referenceId: string; reversed: boolean; reversedBy?: string }[] = [];

  constructor(seed: PmsReservation[] = []) {
    for (const r of seed) this.reservations.set(r.reservationRef, r);
  }

  seedReservation(r: PmsReservation): void {
    this.reservations.set(r.reservationRef, r);
  }

  // `async` (not sync-return-Promise.resolve): throws must surface as REJECTED promises, exactly
  // as a real provider's failure would — same reasoning as MockPosProvider.
  // eslint-disable-next-line @typescript-eslint/require-await -- port signature; see above
  async lookupReservation(i: { name?: string | undefined; room?: string | undefined }): Promise<{ reservations: PmsReservation[] }> {
    let all = [...this.reservations.values()];
    if (i.room !== undefined) all = all.filter((r) => r.room === i.room);
    if (i.name !== undefined) {
      const needle = i.name.toLowerCase();
      all = all.filter((r) => r.guestName.toLowerCase().includes(needle));
    }
    return { reservations: all.map((r) => ({ ...r })) };
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- port signature; see lookupReservation
  async postCharge(i: { reservationRef: string; amount: number; currency: string; chargeCode: string; description: string; referenceId: string }): Promise<{ postingRef: string }> {
    const r = this.reservations.get(i.reservationRef);
    if (!r) throw err('not_found', 'reservation');
    // Defense in depth demanded by the port: callers check noPost first, but a handler bug that
    // skips the check must fail LOUDLY here, not silently post to a folio that refuses charges.
    if (r.noPost) throw err('failed_precondition', 'no_post', { reason: 'no_post' }); // Ruling AY: clients branch on details.reason
    const postingRef = `mock_${this.nextRef++}`;
    this.postings.push({ postingRef, ...i, reversed: false });
    return { postingRef };
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- port signature; see lookupReservation
  async reverseCharge(i: { postingRef: string; referenceId: string }): Promise<void> {
    const posting = this.postings.find((p) => p.postingRef === i.postingRef);
    if (!posting) throw err('not_found', 'posting'); // a ref this adapter did not mint (Ruling X)
    if (posting.reversed) {
      // L2 port contract: same referenceId = the caller's own crash-retry — success no-op. A
      // DIFFERENT referenceId is a genuine double-reverse and stays loud.
      if (posting.reversedBy === i.referenceId) return;
      throw err('failed_precondition', 'already reversed');
    }
    posting.reversed = true;
    posting.reversedBy = i.referenceId;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- port signature; see lookupReservation
  async healthCheck(): Promise<{ ok: boolean; message?: string }> {
    return { ok: true };
  }
}
