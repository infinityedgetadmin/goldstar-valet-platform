import { describe, it } from 'vitest';
import { collection, collectionGroup, doc, getDoc, getDocs, query, setDoc, updateDoc, where, writeBatch, deleteField } from 'firebase/firestore';
import {
  ADMIN, ATT, ATT_V2, DRIVER, LEAD, NOW, OP, PLATFORM, TID, V1, V2, VENUE_USER,
  anon, assertFails, assertSucceeds, baseTicket, ctx, seed, seedTenant,
} from './helpers';

// Final whole-branch review fix wave (2026-08-23-01b): missing coverage flagged by finding 7 / Ruling AC,
// plus dedicated tests for Rulings W and X. Rulings T and U have their own tests in 42-critical-fixes.test.ts.

describe('hostRequests: create/read/update venue-scoped and by==self for everyone incl. admins (Ruling W)', () => {
  it('venue_user creates at their own venue with by==self; admin may create for a venue they are not claimed at but still only as themself; cross-venue and forged-by creates denied', async () => {
    await seedTenant();
    await assertSucceeds(setDoc(doc(VENUE_USER(), `operators/${OP}/hostRequests/hr1`), { id: 'hr1', operatorId: OP, venueId: V1, kind: 'car', at: NOW, by: 'host1', status: 'open' }));
    await assertFails(setDoc(doc(VENUE_USER(), `operators/${OP}/hostRequests/hr2`), { id: 'hr2', operatorId: OP, venueId: V2, kind: 'car', at: NOW, by: 'host1', status: 'open' }));   // not claimed at v2
    await assertFails(setDoc(doc(VENUE_USER(), `operators/${OP}/hostRequests/hr3`), { id: 'hr3', operatorId: OP, venueId: V1, kind: 'car', at: NOW, by: 'someone-else', status: 'open' }));   // forged by
    await assertSucceeds(setDoc(doc(ADMIN(), `operators/${OP}/hostRequests/hr4`), { id: 'hr4', operatorId: OP, venueId: V2, kind: 'car', at: NOW, by: 'adm1', status: 'open' }));   // admin, venue they have no claim for, but by==self
    await assertFails(setDoc(doc(ADMIN(), `operators/${OP}/hostRequests/hr5`), { id: 'hr5', operatorId: OP, venueId: V2, kind: 'car', at: NOW, by: 'someone-else', status: 'open' }));   // Ruling W: forged by denied for admins too
  });
  it('read is venue-scoped for venue_user, unrestricted for managers; update requires the updater\'s venue and is field-locked', async () => {
    await seedTenant();
    await seed(async (db) => {
      await setDoc(doc(db, `operators/${OP}/hostRequests/hr1`), { id: 'hr1', operatorId: OP, venueId: V1, kind: 'car', at: NOW, by: 'host1', status: 'open' });
      await setDoc(doc(db, `operators/${OP}/hostRequests/hr2`), { id: 'hr2', operatorId: OP, venueId: V2, kind: 'car', at: NOW, by: 'host2', status: 'open' });
    });
    await assertSucceeds(getDoc(doc(VENUE_USER(), `operators/${OP}/hostRequests/hr1`)));
    await assertFails(getDoc(doc(VENUE_USER(), `operators/${OP}/hostRequests/hr2`)));
    await assertSucceeds(getDoc(doc(LEAD(), `operators/${OP}/hostRequests/hr2`)));
    await assertSucceeds(updateDoc(doc(ATT(), `operators/${OP}/hostRequests/hr1`), { status: 'matched', ticketId: TID }));
    await assertFails(updateDoc(doc(ATT_V2(), `operators/${OP}/hostRequests/hr1`), { status: 'matched' }));   // Ruling W: cross-venue update now denied
    await assertFails(updateDoc(doc(ATT(), `operators/${OP}/hostRequests/hr1`), { note: 'rewritten' }));   // field-locked
  });
});

describe('damageReports.update: venue-scoped and frozen once the ticket closes/cancels (Ruling W)', () => {
  it('other-venue staff denied; same-venue staff may edit while the ticket is active; denied once the ticket is closed or cancelled', async () => {
    await seedTenant();
    const R = `operators/${OP}/damageReports/rep1`;
    await seed(async (db) => {
      await setDoc(doc(db, `operators/${OP}/tickets/${TID}`), baseTicket({ status: 'ready' }));
      await setDoc(doc(db, R), { id: 'rep1', operatorId: OP, ticketId: TID, vehicleSnapshot: { plate: 'ABC123' }, phase: 'check_in', diagramMarks: [], notes: '', createdBy: 'att1', createdAt: NOW });
    });
    await assertFails(updateDoc(doc(ATT_V2(), R), { notes: 'other venue tamper' }));
    await assertSucceeds(updateDoc(doc(ATT(), R), { notes: 'scratch confirmed' }));
    await seed(async (db) => updateDoc(doc(db, `operators/${OP}/tickets/${TID}`), { status: 'closed' }));
    await assertFails(updateDoc(doc(ATT(), R), { notes: 'post-close tamper' }));
  });
});

describe('tickets: attendants self-queries listable (myClaimed/myPrimaryJobs/myChaseJobs, Ruling X)', () => {
  it('a staff member may list tickets where they are claimedBy/primaryDriverUid/chaseDriverUid, without needing manager or venue-list scope', async () => {
    await seedTenant();
    await seed(async (db) => {
      await setDoc(doc(db, `operators/${OP}/tickets/${TID}`), baseTicket({ status: 'claimed', attendants: { checkedInBy: 'att1', claimedBy: 'att1' } }));
      const T2 = '01912345-7abc-7def-8123-456789abcd30';
      await setDoc(doc(db, `operators/${OP}/tickets/${T2}`), baseTicket({ id: T2, jobType: 'drive_home', status: 'assigned', attendants: { primaryDriverUid: 'drv1', chaseDriverUid: 'drv2' } }));
    });
    await assertSucceeds(getDocs(query(collection(ATT(), `operators/${OP}/tickets`), where('attendants.claimedBy', '==', 'att1'))));
    await assertSucceeds(getDocs(query(collection(DRIVER(), `operators/${OP}/tickets`), where('attendants.primaryDriverUid', '==', 'drv1'))));
    const drv2 = ctx('drv2', { operatorId: OP, roles: ['attendant', 'driver'], venueIds: [V1] });
    await assertSucceeds(getDocs(query(collection(drv2, `operators/${OP}/tickets`), where('attendants.chaseDriverUid', '==', 'drv2'))));
    // someone else's claimedBy filter returns nothing they're entitled to read as a non-manager/non-venue query
    await assertFails(getDocs(query(collection(ATT_V2(), `operators/${OP}/tickets`), where('attendants.claimedBy', '==', 'att1'))));
  });
});

describe('collectionGroup(photos) list is self-scoped (Ruling X)', () => {
  it('actorUid==self succeeds; unconstrained or another actor is denied', async () => {
    await seedTenant();
    await seed(async (db) => setDoc(doc(db, `operators/${OP}/damageReports/rep1/photos/ph1`), { id: 'ph1', actorUid: 'att1', at: NOW, stage: 'wide' }));
    await assertSucceeds(getDocs(query(collectionGroup(ATT(), 'photos'), where('actorUid', '==', 'att1'))));
    await assertFails(getDocs(collectionGroup(ATT(), 'photos')));
    await assertFails(getDocs(query(collectionGroup(ATT(), 'photos'), where('actorUid', '==', 'lead1'))));
  });
});

describe('users/{uid}/payouts', () => {
  it('self and admin read; a peer is denied; unwritable by anyone', async () => {
    await seedTenant();
    await seed(async (db) => setDoc(doc(db, `operators/${OP}/users/att1/payouts/p1`), { id: 'p1', amount: 100, status: 'paid' }));
    await assertSucceeds(getDoc(doc(ATT(), `operators/${OP}/users/att1/payouts/p1`)));
    await assertSucceeds(getDoc(doc(ADMIN(), `operators/${OP}/users/att1/payouts/p1`)));
    await assertFails(getDoc(doc(ATT_V2(), `operators/${OP}/users/att1/payouts/p1`)));
    await assertFails(setDoc(doc(ADMIN(), `operators/${OP}/users/att1/payouts/p2`), { id: 'p2' }));
  });
});

describe('liveLocations read', () => {
  it('managers and same-venue staff/venue_user read; other-venue denied', async () => {
    await seedTenant();
    await seed(async (db) => {
      await setDoc(doc(db, `operators/${OP}/tickets/${TID}`), baseTicket({ jobType: 'drive_home', status: 'in_transit', attendants: { primaryDriverUid: 'drv1', chaseDriverUid: 'drv2' } }));
      await setDoc(doc(db, `operators/${OP}/liveLocations/drv1`), { ticketId: TID, geo: { lat: 39.7, lng: -86.1 }, heading: 0, speed: 0, at: NOW, expiresAt: NOW });
    });
    await assertSucceeds(getDoc(doc(LEAD(), `operators/${OP}/liveLocations/drv1`)));
    await assertSucceeds(getDoc(doc(ATT(), `operators/${OP}/liveLocations/drv1`)));
    await assertSucceeds(getDoc(doc(VENUE_USER(), `operators/${OP}/liveLocations/drv1`)));
    await assertFails(getDoc(doc(ATT_V2(), `operators/${OP}/liveLocations/drv1`)));
  });
});

describe('liveLocations write: chase gets the same geo/ticketId shape checks; inactive job denied (Ruling AB)', () => {
  it('chase driver with a bad geo shape or missing ticketId is denied like primary would be; a closed ticket denies both roles', async () => {
    await seedTenant();
    await seed(async (db) => setDoc(doc(db, `operators/${OP}/tickets/${TID}`), baseTicket({ jobType: 'drive_home', status: 'in_transit', attendants: { primaryDriverUid: 'drv1', chaseDriverUid: 'drv2' } })));
    const drv2 = ctx('drv2', { operatorId: OP, roles: ['attendant', 'driver'], venueIds: [V1] });
    await assertFails(setDoc(doc(drv2, `operators/${OP}/liveLocations/drv2`), { ticketId: TID, geo: { lat: 'not-a-number', lng: -86.1 }, heading: 0, speed: 0, at: NOW, expiresAt: NOW }));
    await assertFails(setDoc(doc(drv2, `operators/${OP}/liveLocations/drv2`), { geo: { lat: 39.7, lng: -86.1 }, heading: 0, speed: 0, at: NOW, expiresAt: NOW }));
    await assertSucceeds(setDoc(doc(drv2, `operators/${OP}/liveLocations/drv2`), { ticketId: TID, geo: { lat: 39.7, lng: -86.1 }, heading: 0, speed: 0, at: NOW, expiresAt: NOW }));
    await seed(async (db) => updateDoc(doc(db, `operators/${OP}/tickets/${TID}`), { status: 'closed' }));
    await assertFails(setDoc(doc(DRIVER(), `operators/${OP}/liveLocations/drv1`), { ticketId: TID, geo: { lat: 39.7, lng: -86.1 }, heading: 0, speed: 0, at: NOW, expiresAt: NOW }));
  });
});

describe('invoices: venue_user is venue-scoped', () => {
  it('venue_user reads their own venue invoice; cross-venue denied; admin unrestricted', async () => {
    await seedTenant();
    await seed(async (db) => {
      await setDoc(doc(db, `operators/${OP}/invoices/inv1`), { id: 'inv1', operatorId: OP, venueId: V1, period: '2026-08' });
      await setDoc(doc(db, `operators/${OP}/invoices/inv2`), { id: 'inv2', operatorId: OP, venueId: V2, period: '2026-08' });
    });
    await assertSucceeds(getDoc(doc(VENUE_USER(), `operators/${OP}/invoices/inv1`)));
    await assertFails(getDoc(doc(VENUE_USER(), `operators/${OP}/invoices/inv2`)));
    await assertSucceeds(getDoc(doc(ADMIN(), `operators/${OP}/invoices/inv2`)));
  });
});

describe('keyTags: release happy path (custody-coupled, mirrors the assign flow)', () => {
  it('a keys_returned custody event + ticket delivered + keyTag available succeed together in one batch', async () => {
    await seedTenant();
    const evId = '01912345-7abc-7def-8123-456789abcd11';
    await seed(async (db) => {
      await setDoc(doc(db, `operators/${OP}/keyTags/k1`), { id: 'k1', operatorId: OP, value: 'GS-V1-0001', venueId: V1, status: 'assigned', currentTicketId: TID });
      await setDoc(doc(db, `operators/${OP}/tickets/${TID}`), baseTicket({ status: 'ready', keyTagId: 'k1', attendants: { checkedInBy: 'att1', claimedBy: 'att1' } }));
    });
    const attDb = ATT();
    const b = writeBatch(attDb);
    b.set(doc(attDb, `operators/${OP}/tickets/${TID}/custodyEvents/${evId}`), { id: evId, actorUid: 'att1', action: 'keys_returned', at: NOW, deviceId: 'd1' });
    b.update(doc(attDb, `operators/${OP}/tickets/${TID}`), { status: 'delivered', 'times.deliveredAt': NOW, 'attendants.deliveredBy': 'att1', lastCustodyEventId: evId });
    b.update(doc(attDb, `operators/${OP}/keyTags/k1`), { status: 'available', currentTicketId: deleteField(), lastCustodyEventId: evId });
    await assertSucceeds(b.commit());
  });
});

describe('deny-all Functions-only top-levels', () => {
  it('surveys, rateLimits, pushEvents, quoteRequests, teamApplications are unreadable and unwritable by any client role, including platform admin', async () => {
    for (const c of ['surveys', 'rateLimits', 'pushEvents', 'quoteRequests', 'teamApplications']) {
      await seed(async (db) => setDoc(doc(db, `${c}/x`), { id: 'x' }));
      await assertFails(getDoc(doc(PLATFORM(), `${c}/x`)));
      await assertFails(getDoc(doc(anon(), `${c}/x`)));
      await assertFails(setDoc(doc(PLATFORM(), `${c}/y`), { id: 'y' }));
    }
  });
});

describe('tickets branch 4: venue_user host-portal request is times.requestedAt-only (re-review N1)', () => {
  it('venue_user transitions checked_in→requested writing only times.requestedAt; co-editing times.checkedInAt denied', async () => {
    await seedTenant();
    await seed(async (db) => {
      await setDoc(doc(db, `operators/${OP}/tickets/${TID}`), baseTicket({ status: 'checked_in' }));
    });
    await assertFails(updateDoc(doc(VENUE_USER(), `operators/${OP}/tickets/${TID}`), {
      status: 'requested', 'times.requestedAt': NOW, 'times.checkedInAt': '2026-08-23T00:00:00.000Z',
    }));
    await assertSucceeds(updateDoc(doc(VENUE_USER(), `operators/${OP}/tickets/${TID}`), {
      status: 'requested', 'times.requestedAt': NOW,
    }));
  });
});
