import { describe, it } from 'vitest';
import { doc, writeBatch } from 'firebase/firestore';
import { ATT, NOW, OP, TID, TOKEN, V1, assertSucceeds, seedTenant } from './helpers';

// Final whole-branch review fix wave (2026-08-23-02b, Ruling AB / test adequacy note): the review
// found NO emulator test exercises the real `commitCheckIn` batch shape (mobile's
// src/features/check-in/commit.ts) — the exact 5 writes issued in ONE batch when a key tag was
// scanned and photos were not skipped: the ticket (create), its `checked_in` custody event, its
// `keys_stored` custody event, the keyTag's assign update, and the check-in damage report
// (create). Ruling J's own regression test (42-critical-fixes.test.ts) only covers ticket+report
// (2 writes); the keyTags custody-batch test in 43-final-wave.test.ts only covers ticket+event+
// tag (3, at 'ready'→'delivered', not check-in). This mirrors commit.ts verbatim.
describe('commitCheckIn batch shape (Ruling AB): ticket + checked_in + keys_stored + keyTag assign + damageReport, ONE batch', () => {
  it('succeeds together — the exact 5-write shape commit.ts issues on a keyed, photographed check-in', async () => {
    await seedTenant();
    const checkedInId = '01912345-7abc-7def-8123-456789abcd50';
    const keysId = '01912345-7abc-7def-8123-456789abcd51';
    const reportId = '01912345-7abc-7def-8123-456789abcd52';

    const attDb = ATT();
    const b = writeBatch(attDb);
    b.set(doc(attDb, `operators/${OP}/tickets/${TID}`), {
      id: TID, operatorId: OP, venueId: V1, jobType: 'valet', status: 'checked_in', source: 'staff',
      guest: { phoneE164: '+13175550123', phoneLast4: '0123', consentSms: true },
      vehicle: { plate: 'ABC123', state: 'IN', make: 'Honda', model: 'Civic', color: 'Blue' },
      keyTagId: 'k1', zoneId: 'A', spotLabel: 'A-12',
      flags: { assistance: false, accessibleVehicle: false, photosSkipped: false, vip: false },
      attendants: { checkedInBy: 'att1' }, times: { checkedInAt: NOW },
      damageReportIds: [reportId], incidentIds: [], guestToken: TOKEN,
      lastCustodyEventId: keysId,
    });
    b.set(doc(attDb, `operators/${OP}/tickets/${TID}/custodyEvents/${checkedInId}`), {
      id: checkedInId, actorUid: 'att1', action: 'checked_in', at: NOW, deviceId: 'd1', zoneId: 'A', spotLabel: 'A-12',
    });
    b.set(doc(attDb, `operators/${OP}/tickets/${TID}/custodyEvents/${keysId}`), {
      id: keysId, actorUid: 'att1', action: 'keys_stored', at: NOW, deviceId: 'd1', zoneId: 'A', spotLabel: 'A-12',
    });
    b.update(doc(attDb, `operators/${OP}/keyTags/k1`), {
      status: 'assigned', currentTicketId: TID, lastCustodyEventId: keysId,
    });
    b.set(doc(attDb, `operators/${OP}/damageReports/${reportId}`), {
      id: reportId, operatorId: OP, ticketId: TID, vehicleSnapshot: { plate: 'ABC123', make: 'Honda', model: 'Civic', color: 'Blue' },
      phase: 'check_in', diagramMarks: [{ panel: 'front_left_door', x: 0.5, y: 0.5, kind: 'scratch', preExisting: true }],
      notes: '', createdBy: 'att1', createdAt: NOW,
    });

    await assertSucceeds(b.commit());
  });
});
