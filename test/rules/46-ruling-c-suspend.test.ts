import { describe, it } from 'vitest';
import { doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';
import { ADMIN, ATT, LEAD, NOW, OP, OWNER, PLATFORM, TID, V1, anon, assertFails, assertSucceeds, baseTicket, seed, seedTenant } from './helpers';

// Ruling C (task-3-report.md follow-up): platformSetOperatorStatus('suspended') previously had zero
// access-control effect — nothing in firestore.rules ever read operators/{op}.status. inOperator()
// now denies once the operator doc's status is explicitly 'suspended' (see its comment in
// firestore.rules for the full writeup, including why this needed a venueMatch() extraction to stay
// under the rules interpreter's 1000-expression-per-evaluation limit on tickets/{ticketId}'s update
// rule specifically).
const T = `operators/${OP}/tickets/${TID}`;

async function suspendOperator() {
  await seed(async (db) => updateDoc(doc(db, `operators/${OP}`), { status: 'suspended' }));
}

describe('Ruling C: suspended operator blocks staff access at the rules boundary', () => {
  it('denies staff (owner/admin/lead/attendant) reads AND writes across tickets, venues, users, keyTags, shifts once suspended', async () => {
    await seedTenant();
    await seed(async (db) => setDoc(doc(db, T), baseTicket()));
    await seed(async (db) => setDoc(doc(db, `operators/${OP}/shifts/sh1`), { id: 'sh1', operatorId: OP, venueId: V1, assignedUids: ['att1'], source: { provider: 'internal' }, tipPool: false }));
    await suspendOperator();

    // tickets: attendant read + write
    await assertFails(getDoc(doc(ATT(), T)));
    await assertFails(updateDoc(doc(ATT(), T), { status: 'requested', 'times.requestedAt': NOW }));
    // venues: admin read + write
    await assertFails(getDoc(doc(ADMIN(), `operators/${OP}/venues/${V1}`)));
    await assertFails(updateDoc(doc(ADMIN(), `operators/${OP}/venues/${V1}`), { name: 'Renamed' }));
    // users: lead (manager) read + write on another staff doc
    await assertFails(getDoc(doc(LEAD(), `operators/${OP}/users/att1`)));
    await assertFails(updateDoc(doc(ADMIN(), `operators/${OP}/users/att1`), { displayName: 'New Name' }));
    // keyTags: owner read
    await assertFails(getDoc(doc(OWNER(), `operators/${OP}/keyTags/k1`)));
    // shifts: manager (lead) read + write (tipPool/id/operatorId/venueId/source are locked by the
    // shift update rule itself — unrelated to suspension — so assignedUids is the mutable field here)
    await assertFails(getDoc(doc(LEAD(), `operators/${OP}/shifts/sh1`)));
    await assertFails(updateDoc(doc(LEAD(), `operators/${OP}/shifts/sh1`), { assignedUids: ['att1', 'lead1'] }));
  });

  it('platform_admin still allowed on a suspended operator — can inspect and reactivate it', async () => {
    await seedTenant();
    await seed(async (db) => setDoc(doc(db, T), baseTicket()));
    await suspendOperator();

    await assertSucceeds(getDoc(doc(PLATFORM(), `operators/${OP}`)));
    await assertSucceeds(getDoc(doc(PLATFORM(), `operators/${OP}/venues/${V1}`)));
    await assertSucceeds(getDoc(doc(PLATFORM(), T)));
    await assertSucceeds(updateDoc(doc(PLATFORM(), `operators/${OP}`), { status: 'active' }));
  });

  it("a suspended operator's guestTickets projection is still readable by an anonymous guest token holder (deliberately not gated)", async () => {
    await seedTenant();
    await seed(async (db) => setDoc(doc(db, 'guestTickets/tok-ruling-c'), { operatorId: OP, ticketId: TID, venueName: 'St. Elmo', jobType: 'valet', status: 'checked_in' }));
    await suspendOperator();

    await assertSucceeds(getDoc(doc(anon(), 'guestTickets/tok-ruling-c')));
  });

  it('a missing status field on the operator doc does not lock everyone out — only an explicit "suspended" value denies', async () => {
    await seedTenant();
    // Overwrite (not merge) — removes the status field entirely, simulating a legacy/malformed doc.
    await seed(async (db) =>
      setDoc(doc(db, `operators/${OP}`), {
        id: OP,
        name: 'Goldstar',
        slug: OP,
        timezone: 'America/Indiana/Indianapolis',
        currency: 'USD',
        isSandbox: false,
        plan: 'standard',
        branding: { displayName: 'Goldstar', primaryColor: '#ab6034', accentColor: '#ffc30c' },
        modules: {},
        features: {},
        createdAt: NOW,
        updatedAt: NOW,
        createdBy: 'system',
      })
    );

    await assertSucceeds(getDoc(doc(ATT(), `operators/${OP}/venues/${V1}`)));
  });
});
