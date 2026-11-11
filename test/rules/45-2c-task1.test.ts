import { describe, it } from 'vitest';
import { deleteField, doc, setDoc, writeBatch } from 'firebase/firestore';
import { LEAD, NOW, OP, TID, V1, assertSucceeds, baseTicket, seed, seedTenant } from './helpers';

// Plan 2c Task 1 (2026-08-24, Ruling B): mobile's transitionTicket cancels a ticket that still
// holds a key tag by releasing it in the SAME batch as the cancel — the same custody-coupled
// shape 43-final-wave.test.ts's "keyTags: release happy path" already covers for `delivered`,
// exercised here for a manager's `cancelled` transition instead. The ticket patch stamps its OWN
// `lastCustodyEventId` too (not just the key tag's), mirroring the `delivered` path exactly.
describe('keyTags: release on a manager cancel (Ruling B, mirrors the delivered release flow)', () => {
  it('a lead cancelling a ticket with a key tag: ticket update + keys_returned custody event + keyTag available succeed together in one batch', async () => {
    await seedTenant();
    const relId = '01912345-7abc-7def-8123-456789abcd12';
    await seed(async (db) => {
      await setDoc(doc(db, `operators/${OP}/keyTags/k1`), { id: 'k1', operatorId: OP, value: 'GS-V1-0001', venueId: V1, status: 'assigned', currentTicketId: TID });
      await setDoc(doc(db, `operators/${OP}/tickets/${TID}`), baseTicket({ status: 'checked_in', keyTagId: 'k1' }));
    });

    const leadDb = LEAD();
    const b = writeBatch(leadDb);
    b.set(doc(leadDb, `operators/${OP}/tickets/${TID}/custodyEvents/${relId}`), {
      id: relId, actorUid: 'lead1', action: 'keys_returned', at: NOW, deviceId: 'd1', note: 'released on cancel',
    });
    b.update(doc(leadDb, `operators/${OP}/tickets/${TID}`), {
      status: 'cancelled', cancelReason: 'guest left', 'times.cancelledAt': NOW, lastCustodyEventId: relId,
    });
    b.update(doc(leadDb, `operators/${OP}/keyTags/k1`), { status: 'available', currentTicketId: deleteField(), lastCustodyEventId: relId });

    await assertSucceeds(b.commit());
  });
});
