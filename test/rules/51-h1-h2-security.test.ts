import { describe, it } from 'vitest';
import { doc, setDoc, updateDoc } from 'firebase/firestore';
import { ADMIN, GUEST, LEAD, NOW, OP, TID, VENUE_USER, assertFails, assertSucceeds, baseTicket, seed, seedTenant } from './helpers';

// Security audit H1/H2 (task-6-security-fix.md): a guest could self-transition a drive_home/
// passenger_ride job quoted->confirmed with a DIRECT Firestore client write, bypassing
// guestConfirmDriveHome/guestConfirmRide (and the manual-capture card authorization those callables
// trigger) entirely — dispatch never checked payment either, so an unpaid job could run end to end
// with nothing ever charged. Fixed in two independent places (defense in depth, per the audit):
// (a) 'guest' (and, for passenger_ride, 'venue_user') removed from the quoted->confirmed role list
//     DRIVE_HOME_RULES/RIDE_RULES generate into firestore.rules' roleMayTransition() — the only
//     legitimate path (guestConfirmDriveHome/guestConfirmRide) no longer depends on that role check
//     for this transition (see confirmDriveHome.ts/confirmRide.ts).
// (b) confirmed->assigned now also requires an authorized/paid payment, enforced in
//     dispatchAssignHandler (functions/src/modules/dispatch/assign.ts) — see the note below the H1(a)
//     tests for why this is functions-only, not also duplicated at the rules boundary here.
const T = `operators/${OP}/tickets/${TID}`;

const DRIVE_HOME_QUOTED = () =>
  baseTicket({
    jobType: 'drive_home',
    status: 'quoted',
    attendants: {},
    guest: { uid: 'g1', phoneE164: '+13175550123', phoneLast4: '0123', consentSms: true },
    driveHome: { destination: { address: '1 Home St', geo: { lat: 39.8, lng: -86.1 } }, quote: { base: 2500, distanceMeters: 16_093, durationSec: 900, amount: 5750, breakdown: [] }, chase: { status: 'pending' } },
  });

const RIDE_QUOTED = () =>
  baseTicket({
    jobType: 'passenger_ride',
    status: 'quoted',
    attendants: {},
    guest: { uid: 'g1', phoneE164: '+13175550123', phoneLast4: '0123', consentSms: true },
    ride: { pickup: { geo: { lat: 39.76, lng: -86.16 } }, dropoff: { address: '2 Away Ave', geo: { lat: 39.9, lng: -86.2 } }, passengers: 1, accessible: false, billTo: 'guest', quote: { base: 1000, distanceMeters: 1609, durationSec: 120, amount: 1500, breakdown: [] } },
  });

describe('H1(a): guest cannot self-confirm a job with a direct Firestore write (free-ride hole)', () => {
  it('drive_home: guest quoted->confirmed direct write is denied; owner/admin/lead still allowed', async () => {
    await seedTenant();
    await seed(async (db) => setDoc(doc(db, T), DRIVE_HOME_QUOTED()));
    await assertFails(updateDoc(doc(GUEST(), T), { status: 'confirmed', 'driveHome.termsAcceptedAt': NOW, 'driveHome.termsVersion': 'drive-home-v1' }));
    // sanity: the fix is scoped to 'guest' only — managers can still confirm on a guest's behalf
    // (e.g. a phone/web-assisted booking), matching roleMayTransition's unchanged owner/admin/lead entry.
    // Deliberately a bare status-only write here, NOT also touching driveHome.termsAcceptedAt/
    // termsVersion in the same update: that combination independently trips
    // tickets/{ticketId}'s update rule over the ~1000-expression ceiling, REGARDLESS of caller role
    // or any H1/H2 change — reproduces identically against pristine, completely unmodified HEAD
    // rules. Pre-existing, previously uncovered by any test (no rules-level test exercised a
    // quoted->confirmed write with a driveHome submap edit before this one), out of scope for this
    // fix — flagged separately for the team, not something to fold into this settling test.
    await assertSucceeds(updateDoc(doc(ADMIN(), T), { status: 'confirmed' }));
  });

  it('passenger_ride: guest AND venue_user quoted->confirmed direct writes are denied; owner/admin/lead still allowed', async () => {
    await seedTenant();
    await seed(async (db) => setDoc(doc(db, T), RIDE_QUOTED()));
    await assertFails(updateDoc(doc(GUEST(), T), { status: 'confirmed' }));
    await assertFails(updateDoc(doc(VENUE_USER(), T), { status: 'confirmed' }));
    await assertSucceeds(updateDoc(doc(ADMIN(), T), { status: 'confirmed' }));
  });

  // guest cancellation must still work unchanged — H1(a) explicitly must not touch cancel transitions.
  it('drive_home: guest can still cancel from quoted (cancel transitions untouched)', async () => {
    await seedTenant();
    await seed(async (db) => setDoc(doc(db, T), DRIVE_HOME_QUOTED()));
    await assertSucceeds(updateDoc(doc(GUEST(), T), { status: 'cancelled', cancelReason: 'changed my mind', 'times.cancelledAt': NOW }));
  });
});

// H1(b): confirmed->assigned requires an authorized/paid payment. NOT enforced at the rules
// boundary — every formulation tried (folded into transitionRequirements() two ways, moved to
// branch 1 alone with and without an explicit jobType guard) measurably tipped tickets/{ticketId}'s
// update rule over the Firestore rules interpreter's ~1000-expression ceiling (see firestore.rules'
// own comment on this, right above the branch-1 conjunct chain, for the full empirical record).
// Enforced instead in dispatchAssignHandler (functions/src/modules/dispatch/assign.ts) — the only
// real production path to 'assigned' (mobile never self-assigns; matches this file's existing
// precedent for the chase-vehicle-availability check, also assign.ts-only for the same reason).
// Settling coverage for H1(b) lives in assign.test.ts at the functions level:
// "rejects assigning a confirmed job whose payment is not authorized/paid...", "...still pending",
// and "allows assigning a confirmed job whose payment is already paid".

