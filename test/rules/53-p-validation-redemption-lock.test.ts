import { describe, it } from 'vitest';
import { doc, setDoc, updateDoc, deleteField } from 'firebase/firestore';
import { ADMIN, ATT, LEAD, NOW, OP, TID, VENUE_USER, assertFails, assertSucceeds, seed, seedTenant } from './helpers';

// Ruling P (Plan 7 T1): validation redemption is Functions-only. The old validations `update`
// branch let same-venue staff set `redeemedTicketId` directly from a client — a second redemption
// path outside venue/validation.ts's shared transactional guard (Ruling F: ONE path), and one
// that produced a half-redeemed state: the ticket's `payment.validationId`/`validationAmount`
// were never applied (next checkout silently charged full price), no `redemption {amount, base,
// at}` group was written, and no `processedEvents/val_{id}` marker existed for Task 3's POS
// mutual exclusion. This suite is written to FAIL against the pre-lock rules (the staff-redeem
// cases below asserted the OPPOSITE outcome there — revert-verified in task-1-platform-report.md)
// and to pin the admin edit surface that legitimately remains.
const V = `operators/${OP}/validations/val_lock1`;

const validation = (over: Record<string, unknown> = {}) => ({
  id: 'val_lock1',
  operatorId: OP,
  venueId: 'v1',
  code: 'AB23CD',
  type: 'full',
  issuedBy: 'vu1',
  issuedAt: NOW,
  ...over,
});

describe('Ruling P: the client redeemedTicketId side-door is closed', () => {
  it('same-venue staff (the branch that used to succeed), lead, and venue_user can no longer set redeemedTicketId', async () => {
    await seedTenant();
    await seed(async (db) => setDoc(doc(db, V), validation()));
    await assertFails(updateDoc(doc(ATT(), V), { redeemedTicketId: TID }));
    await assertFails(updateDoc(doc(LEAD(), V), { redeemedTicketId: TID }));
    await assertFails(updateDoc(doc(VENUE_USER(), V), { redeemedTicketId: TID }));
  });

  it('an ADMIN cannot set redeemedTicketId or the redemption group either — no client redemption path remains', async () => {
    await seedTenant();
    await seed(async (db) => setDoc(doc(db, V), validation()));
    await assertFails(updateDoc(doc(ADMIN(), V), { redeemedTicketId: TID }));
    await assertFails(updateDoc(doc(ADMIN(), V), { redemption: { amount: 1500, base: 1500, at: NOW } }));
  });

  it('a client cannot UN-redeem or re-point a Functions-written redemption', async () => {
    await seedTenant();
    await seed(async (db) => setDoc(doc(db, V), validation({ redeemedTicketId: TID, redemption: { amount: 1500, base: 1500, at: NOW } })));
    await assertFails(updateDoc(doc(ADMIN(), V), { redeemedTicketId: '01912345-7abc-7def-8123-456789abcd02' }));
    await assertFails(updateDoc(doc(ATT(), V), { redemption: { amount: 1, base: 1, at: NOW } }));
  });

  it('admins keep a real (non-redemption) edit surface: expiring a code is allowed, identity fields stay pinned', async () => {
    await seedTenant();
    await seed(async (db) => setDoc(doc(db, V), validation()));
    await assertSucceeds(updateDoc(doc(ADMIN(), V), { expiresAt: NOW }));
    await assertFails(updateDoc(doc(ADMIN(), V), { code: 'ZZ99XX' }));
    await assertFails(updateDoc(doc(ADMIN(), V), { amount: 1 }));
    await assertFails(updateDoc(doc(ADMIN(), V), { venueId: 'v2' }));
    // non-admin staff have no update path at all any more
    await assertFails(updateDoc(doc(ATT(), V), { expiresAt: NOW }));
  });

  it('T3 review L1: posPush (the H1 push CLAIM) is pinned — a client cannot rewrite or delete it to re-arm the retry path', async () => {
    await seedTenant();
    const posPush = { checkRef: 'mock:1', status: 'pushed', at: NOW };
    await seed(async (db) => setDoc(doc(db, V), validation({ redeemedTicketId: TID, redemption: { amount: 1500, base: 1500, at: NOW }, posPush })));
    // Rewriting it to a failed/other-check state would make posApplyValidation push again for an
    // already-applied discount; deleting it used to re-open the pre-H1 undefined acceptance.
    await assertFails(updateDoc(doc(ADMIN(), V), { posPush: { checkRef: 'mock:1', status: 'failed', at: NOW } }));
    await assertFails(updateDoc(doc(ADMIN(), V), { posPush: deleteField() }));
    await assertFails(updateDoc(doc(ATT(), V), { posPush: { checkRef: 'mock:2', status: 'failed', at: NOW } }));
    // the legitimate admin surface still works alongside the pin
    await assertSucceeds(updateDoc(doc(ADMIN(), V), { expiresAt: NOW }));
  });
});
