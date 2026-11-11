import { describe, expect, it } from 'vitest';
import { canTransition, canTransitionChase, initialStatus, nextStatuses } from './index';
import { VALET_RULES } from './valet';
import { DRIVE_HOME_RULES } from './driveHome';
import { RIDE_RULES } from './ride';
import type { TransitionContext, TransitionRule } from './types';
import type { JobType, TicketStatus } from '../domain/status';

const ok = (r: ReturnType<typeof canTransition>) => { expect(r).toEqual({ ok: true }); };
const no = (r: ReturnType<typeof canTransition>, reason: string) => { expect(r).toMatchObject({ ok: false, reason }); };

describe('valet', () => {
  it('happy path for an attendant who is the claimant', () => {
    ok(canTransition({ jobType: 'valet', from: null, to: 'checked_in', roles: ['attendant'] }));
    ok(canTransition({ jobType: 'valet', from: 'checked_in', to: 'requested', roles: ['guest'] }));
    ok(canTransition({ jobType: 'valet', from: 'requested', to: 'claimed', roles: ['attendant'] }));
    ok(canTransition({ jobType: 'valet', from: 'claimed', to: 'retrieving', roles: ['attendant'], ctx: { isClaimant: true } }));
    ok(canTransition({ jobType: 'valet', from: 'retrieving', to: 'ready', roles: ['attendant'], ctx: { isClaimant: true } }));
    ok(canTransition({ jobType: 'valet', from: 'ready', to: 'delivered', roles: ['attendant'], ctx: { isClaimant: true, hasKeysReturnedEvent: true } }));
    ok(canTransition({ jobType: 'valet', from: 'delivered', to: 'closed', roles: ['attendant'] }));
  });
  it('non-claimant attendant cannot advance someone else\'s retrieval; lead can', () => {
    no(canTransition({ jobType: 'valet', from: 'claimed', to: 'retrieving', roles: ['attendant'], ctx: { isClaimant: false } }), 'role_not_allowed');
    ok(canTransition({ jobType: 'valet', from: 'claimed', to: 'retrieving', roles: ['lead'], ctx: { isClaimant: false } }));
  });
  it('delivered requires keys_returned custody event', () => {
    no(canTransition({ jobType: 'valet', from: 'ready', to: 'delivered', roles: ['lead'], ctx: { hasKeysReturnedEvent: false } }), 'missing_requirement');
  });
  it('staging and un-request', () => {
    ok(canTransition({ jobType: 'valet', from: 'requested', to: 'staged', roles: ['attendant'] }));
    ok(canTransition({ jobType: 'valet', from: 'staged', to: 'ready', roles: ['attendant'] }));
    ok(canTransition({ jobType: 'valet', from: 'requested', to: 'checked_in', roles: ['lead'] }));
    no(canTransition({ jobType: 'valet', from: 'requested', to: 'checked_in', roles: ['attendant'] }), 'role_not_allowed');
  });
  it('a non-claimant attendant can mark a pre-staged car ready; a claimant driver can stage after retrieving', () => {
    ok(canTransition({ jobType: 'valet', from: 'staged', to: 'ready', roles: ['attendant'], ctx: { isClaimant: false } }));
    ok(canTransition({ jobType: 'valet', from: 'retrieving', to: 'staged', roles: ['driver'], ctx: { isClaimant: true } }));
  });
  it('cancel needs lead/admin and a reason; terminal states are final', () => {
    ok(canTransition({ jobType: 'valet', from: 'requested', to: 'cancelled', roles: ['lead'], ctx: { cancelReason: 'guest left' } }));
    no(canTransition({ jobType: 'valet', from: 'requested', to: 'cancelled', roles: ['lead'] }), 'missing_requirement');
    no(canTransition({ jobType: 'valet', from: 'requested', to: 'cancelled', roles: ['attendant'], ctx: { cancelReason: 'x' } }), 'role_not_allowed');
    no(canTransition({ jobType: 'valet', from: 'closed', to: 'requested', roles: ['owner'] }), 'unknown_transition');
    no(canTransition({ jobType: 'valet', from: 'cancelled', to: 'closed', roles: ['owner'] }), 'unknown_transition');
  });
  it('guests can only request', () => {
    no(canTransition({ jobType: 'valet', from: 'requested', to: 'claimed', roles: ['guest'] }), 'role_not_allowed');
  });
  it('nextStatuses lists forward moves', () => {
    expect(nextStatuses('valet', 'requested')).toEqual(['claimed', 'staged', 'checked_in', 'cancelled']);
  });
});

describe('drive_home', () => {
  it('assignment requires both drivers eligible', () => {
    no(canTransition({ jobType: 'drive_home', from: 'confirmed', to: 'assigned', roles: ['lead'], ctx: { primaryEligible: true, chaseEligible: false } }), 'missing_requirement');
    ok(canTransition({ jobType: 'drive_home', from: 'confirmed', to: 'assigned', roles: ['lead'], ctx: { primaryEligible: true, chaseEligible: true } }));
  });
  it('inspection gates', () => {
    no(canTransition({ jobType: 'drive_home', from: 'pre_drive_inspection', to: 'in_transit', roles: ['driver'], ctx: { isClaimant: true, hasPreDriveReport: false } }), 'missing_requirement');
    ok(canTransition({ jobType: 'drive_home', from: 'pre_drive_inspection', to: 'in_transit', roles: ['driver'], ctx: { isClaimant: true, hasPreDriveReport: true } }));
    no(canTransition({ jobType: 'drive_home', from: 'arrived', to: 'completed', roles: ['driver'], ctx: { isClaimant: true, hasPostDriveReport: false } }), 'missing_requirement');
  });
  // H1(a) (task-6-security-fix.md): 'guest' removed from quoted->confirmed's role list — a direct
  // client write (or a naive in-process canTransition({roles:['guest']}) check) must not be able to
  // self-confirm a job, skipping payment authorization. The real guestConfirmDriveHome/
  // guestConfirmRide callables authorize via resolveToken() + their own status branch, not this role
  // check (see confirmDriveHome.ts/confirmRide.ts) — a manager can still confirm on a guest's behalf.
  it('guest moves requested→quoted? no: system quotes; a manager confirms, not the guest', () => {
    ok(canTransition({ jobType: 'drive_home', from: 'requested', to: 'quoted', roles: ['platform_admin'] })); // system acts as platform_admin
    no(canTransition({ jobType: 'drive_home', from: 'quoted', to: 'confirmed', roles: ['guest'] }), 'role_not_allowed');
    ok(canTransition({ jobType: 'drive_home', from: 'quoted', to: 'confirmed', roles: ['lead'] }));
    no(canTransition({ jobType: 'drive_home', from: 'quoted', to: 'assigned', roles: ['guest'] }), 'unknown_transition');
  });
});

describe('passenger_ride', () => {
  it('assignment requires eligible driver and a fleet vehicle', () => {
    no(canTransition({ jobType: 'passenger_ride', from: 'confirmed', to: 'assigned', roles: ['lead'], ctx: { primaryEligible: true, hasFleetVehicle: false } }), 'missing_requirement');
    ok(canTransition({ jobType: 'passenger_ride', from: 'confirmed', to: 'assigned', roles: ['lead'], ctx: { primaryEligible: true, hasFleetVehicle: true } }));
  });
  it('driver drives the trip', () => {
    ok(canTransition({ jobType: 'passenger_ride', from: 'assigned', to: 'en_route_to_pickup', roles: ['driver'], ctx: { isClaimant: true } }));
    ok(canTransition({ jobType: 'passenger_ride', from: 'arrived', to: 'completed', roles: ['driver'], ctx: { isClaimant: true } }));
  });
});

describe('chase', () => {
  it('linear', () => {
    expect(canTransitionChase('pending', 'following')).toBe(true);
    expect(canTransitionChase('following', 'returning_driver')).toBe(true);
    expect(canTransitionChase('returning_driver', 'done')).toBe(true);
    expect(canTransitionChase('pending', 'done')).toBe(false);
  });
});

describe('nextStatuses / initialStatus', () => {
  it('initialStatus per jobType', () => {
    expect(initialStatus('valet')).toBe('checked_in');
    expect(initialStatus('drive_home')).toBe('requested');
    expect(initialStatus('passenger_ride')).toBe('requested');
  });
  it('nextStatuses for drive_home and passenger_ride', () => {
    expect(nextStatuses('drive_home', 'confirmed')).toEqual(['assigned', 'cancelled']);
    expect(nextStatuses('drive_home', null)).toEqual(['requested']);
    expect(nextStatuses('passenger_ride', 'confirmed')).toEqual(['assigned', 'cancelled']);
    expect(nextStatuses('passenger_ride', null)).toEqual(['requested']);
  });
});

// A context where every requires() check is satisfied, so a permitted role's transition
// is gated only by role, never accidentally blocked by a missing_requirement.
const FULL_CTX: TransitionContext = {
  isClaimant: true, hasKeysReturnedEvent: true, hasPreDriveReport: true, hasPostDriveReport: true,
  primaryEligible: true, chaseEligible: true, hasFleetVehicle: true, cancelReason: 'guest requested cancellation',
};

function testTransitionMatrix<S extends TicketStatus>(jobType: JobType, rules: readonly TransitionRule<S>[]): void {
  describe(`${jobType} transition matrix`, () => {
    it('has no duplicate (from,to) pairs', () => {
      const seen = new Set<string>();
      for (const r of rules) {
        const key = `${String(r.from)}->${r.to}`;
        expect(seen.has(key), key).toBe(false);
        seen.add(key);
      }
    });
    for (const rule of rules) {
      const label = `${String(rule.from)} -> ${rule.to}`;
      it(`allows a permitted role for ${label}`, () => {
        const role = rule.roles[0]!;
        ok(canTransition({ jobType, from: rule.from, to: rule.to, roles: [role], ctx: FULL_CTX }));
      });
      const guestPermitted = rule.roles.includes('guest') || (rule.claimantRoles?.includes('guest') ?? false);
      if (!guestPermitted) {
        it(`denies guest for ${label}`, () => {
          no(canTransition({ jobType, from: rule.from, to: rule.to, roles: ['guest'], ctx: FULL_CTX }), 'role_not_allowed');
        });
      }
    }
  });
}

testTransitionMatrix('valet', VALET_RULES);
testTransitionMatrix('drive_home', DRIVE_HOME_RULES);
testTransitionMatrix('passenger_ride', RIDE_RULES);

describe('edge cases', () => {
  it('denies a non-claimant driver on a drive-home leg', () => {
    no(canTransition({ jobType: 'drive_home', from: 'assigned', to: 'en_route_to_guest', roles: ['driver'], ctx: { isClaimant: false } }), 'role_not_allowed');
  });
  it('denies a whitespace-only cancelReason', () => {
    no(canTransition({ jobType: 'valet', from: 'requested', to: 'cancelled', roles: ['lead'], ctx: { cancelReason: '   ' } }), 'missing_requirement');
  });
  it('denies an empty roles list', () => {
    no(canTransition({ jobType: 'valet', from: 'requested', to: 'claimed', roles: [], ctx: {} }), 'role_not_allowed');
  });
});

describe('requirement names', () => {
  it("valet delivered gate returns 'keys_returned'", () => {
    const r = canTransition({ jobType: 'valet', from: 'ready', to: 'delivered', roles: ['lead'], ctx: { hasKeysReturnedEvent: false } });
    expect(r).toMatchObject({ ok: false, reason: 'missing_requirement', requirement: 'keys_returned' });
  });
  it("drive_home assignment gate returns 'eligible_drivers'", () => {
    const r = canTransition({ jobType: 'drive_home', from: 'confirmed', to: 'assigned', roles: ['lead'], ctx: { primaryEligible: false, chaseEligible: false } });
    expect(r).toMatchObject({ ok: false, reason: 'missing_requirement', requirement: 'eligible_drivers' });
  });
  it("drive_home pre-drive gate returns 'pre_drive_report'", () => {
    const r = canTransition({ jobType: 'drive_home', from: 'pre_drive_inspection', to: 'in_transit', roles: ['driver'], ctx: { isClaimant: true, hasPreDriveReport: false } });
    expect(r).toMatchObject({ ok: false, reason: 'missing_requirement', requirement: 'pre_drive_report' });
  });
  it("drive_home post-drive gate returns 'post_drive_report'", () => {
    const r = canTransition({ jobType: 'drive_home', from: 'arrived', to: 'completed', roles: ['driver'], ctx: { isClaimant: true, hasPostDriveReport: false } });
    expect(r).toMatchObject({ ok: false, reason: 'missing_requirement', requirement: 'post_drive_report' });
  });
  it("passenger_ride assignment gate returns 'eligible_driver_and_vehicle'", () => {
    const r = canTransition({ jobType: 'passenger_ride', from: 'confirmed', to: 'assigned', roles: ['lead'], ctx: { primaryEligible: false, hasFleetVehicle: false } });
    expect(r).toMatchObject({ ok: false, reason: 'missing_requirement', requirement: 'eligible_driver_and_vehicle' });
  });
  it("cancel gate returns 'cancelReason'", () => {
    const r = canTransition({ jobType: 'valet', from: 'requested', to: 'cancelled', roles: ['lead'], ctx: {} });
    expect(r).toMatchObject({ ok: false, reason: 'missing_requirement', requirement: 'cancelReason' });
  });
});
