import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildClaims, syncClaimsHandler } from './claims.handler.js';
import { inviteHandler } from './invite.js';
import { acceptHandler } from './accept.js';
import { assumeHandler } from './assume.js';
import { guestLinkHandler } from './guestLink.js';
import { revokeInvitationHandler } from './revoke.js';
import { NOW, OP, TID, testDeps, ticketDoc, wipe, seedOperator } from '../../../test/helpers.js';
import { P } from '../../lib/paths.js';
beforeEach(async () => { await wipe(testDeps()); });
describe('claims', () => {
  it('builds claims and truncates venueIds to 20', () => {
    const c = buildClaims({ operatorId: OP, roles: ['attendant'], venueIds: Array.from({ length: 25 }, (_, i) => `v${i}`), claimsVersion: 3 });
    expect(c).toMatchObject({ operatorId: OP, roles: ['attendant'], claimsVersion: 3 }); expect(c.venueIds).toHaveLength(20);
  });
  // claimsVersion is a CLIENT-side proactive-refresh signal, not a rules-enforcement mechanism — see
  // syncClaimsHandler's own comment (claims.handler.ts) for the full account of why it's kept (both
  // goldstar-transportation and goldstar-mobile watch this doc and force an early token refresh when
  // it outruns their cached claims) and why it isn't ALSO wired into firestore.rules (measurably
  // infeasible against tickets/update's expression ceiling, same finding as H1(b)).
  it('sync sets custom claims on the auth user and bumps claimsVersion on the doc', async () => {
    const deps = testDeps(); await seedOperator(deps);
    const u = await deps.auth.createUser({ uid: 'att1', email: 'a@x.example.com', password: 'password123' });
    await deps.db.doc(P.user(OP, u.uid)).set({ uid: u.uid, operatorId: OP, roles: ['attendant'], venueIds: ['v1'], status: 'active' });
    await syncClaimsHandler(deps, { operatorId: OP, uid: u.uid });
    const rec = await deps.auth.getUser(u.uid); expect(rec.customClaims).toMatchObject({ operatorId: OP, roles: ['attendant'], venueIds: ['v1'] });
    expect((await deps.db.doc(P.user(OP, u.uid)).get()).data()?.claimsVersion).toBe(1);
    await deps.db.doc(P.user(OP, u.uid)).update({ roles: ['attendant', 'lead'] }); await syncClaimsHandler(deps, { operatorId: OP, uid: u.uid });
    expect((await deps.auth.getUser(u.uid)).customClaims?.roles).toEqual(['attendant', 'lead']); expect((await deps.db.doc(P.user(OP, u.uid)).get()).data()?.claimsVersion).toBe(2);
  });
  // The actual invariant both consumers depend on (session-provider.tsx:151,
  // use-session.ts:259): a client holding a token minted with SOME claimsVersion watches the user
  // doc and proactively refreshes once the doc's claimsVersion outruns the version baked into that
  // token. Simulated directly here — a "prior token" claimsVersion captured before a claims-relevant
  // change, then asserted strictly less than the doc's claimsVersion after the change syncs.
  it('propagation contract: a claims-relevant change increments the doc claimsVersion strictly above the version in the prior token', async () => {
    const deps = testDeps(); await seedOperator(deps);
    const u = await deps.auth.createUser({ uid: 'att6', email: 'f@x.example.com', password: 'password123' });
    await deps.db.doc(P.user(OP, u.uid)).set({ uid: u.uid, operatorId: OP, roles: ['attendant'], venueIds: ['v1'], status: 'active' });
    await syncClaimsHandler(deps, { operatorId: OP, uid: u.uid });
    // The claimsVersion a client's already-minted token would carry, matching what setCustomUserClaims
    // just wrote — this is the "prior token" value both apps compare the live doc against.
    const priorTokenClaimsVersion = (await deps.auth.getUser(u.uid)).customClaims?.claimsVersion as number;
    expect(priorTokenClaimsVersion).toBe(1);

    await deps.db.doc(P.user(OP, u.uid)).update({ roles: ['attendant', 'lead'] });
    await syncClaimsHandler(deps, { operatorId: OP, uid: u.uid, priorRoles: ['attendant'] });

    const docClaimsVersion = (await deps.db.doc(P.user(OP, u.uid)).get()).data()?.claimsVersion as number;
    expect(docClaimsVersion).toBeGreaterThan(priorTokenClaimsVersion);
  });
  it('suspended users lose all claims', async () => {
    const deps = testDeps(); await seedOperator(deps); await deps.auth.createUser({ uid: 'att2', email: 'b@x.example.com', password: 'password123' });
    await deps.db.doc(P.user(OP, 'att2')).set({ uid: 'att2', operatorId: OP, roles: ['attendant'], venueIds: ['v1'], status: 'suspended' });
    await syncClaimsHandler(deps, { operatorId: OP, uid: 'att2' }); expect((await deps.auth.getUser('att2')).customClaims).toEqual({ roles: [], claimsVersion: 1 });
  });

  it('Plan 8 Task 10 (#8): the parent operator being suspended rides along as an operatorSuspended claims bit; absent while active', async () => {
    const deps = testDeps(); await seedOperator(deps);
    await deps.auth.createUser({ uid: 'att7', email: 'g@x.example.com', password: 'password123' });
    await deps.db.doc(P.user(OP, 'att7')).set({ uid: 'att7', operatorId: OP, roles: ['attendant'], venueIds: ['v1'], status: 'active', eligibility: { driveHome: false, passengerRide: false, reasons: [] }, createdAt: NOW, updatedAt: NOW });
    await syncClaimsHandler(deps, { operatorId: OP, uid: 'att7' });
    expect(Object.hasOwn((await deps.auth.getUser('att7')).customClaims ?? {}, 'operatorSuspended')).toBe(false);
    await deps.db.doc(P.operator(OP)).update({ status: 'suspended' });
    await syncClaimsHandler(deps, { operatorId: OP, uid: 'att7' });
    expect((await deps.auth.getUser('att7')).customClaims).toMatchObject({ operatorId: OP, roles: ['attendant'], operatorSuspended: true }); // roles kept
    await deps.db.doc(P.operator(OP)).update({ status: 'active' });
    await syncClaimsHandler(deps, { operatorId: OP, uid: 'att7' });
    expect(Object.hasOwn((await deps.auth.getUser('att7')).customClaims ?? {}, 'operatorSuspended')).toBe(false);
  });
  // H2 (task-6-security-fix.md): revokeRefreshTokens on suspension and on role reduction, so a
  // fired/demoted staffer's already-issued ID token can't silently refresh and keep stale privilege.
  // Spies directly on deps.auth.revokeRefreshTokens (still calling through to the real emulator)
  // rather than asserting on UserRecord.tokensValidAfterTime — that field turns out to already be
  // set at account CREATION time by the Auth emulator (not "undefined until revoked" as might be
  // assumed) and only has whole-second string resolution, so a same-second before/after comparison
  // is unreliable. Spying on the call itself is the direct, precise signal.
  it('revokes refresh tokens on suspension', async () => {
    const deps = testDeps(); await seedOperator(deps);
    const revoke = vi.spyOn(deps.auth, 'revokeRefreshTokens');
    const u = await deps.auth.createUser({ uid: 'att3', email: 'c@x.example.com', password: 'password123' });
    await deps.db.doc(P.user(OP, u.uid)).set({ uid: u.uid, operatorId: OP, roles: ['attendant'], venueIds: ['v1'], status: 'active' });
    await syncClaimsHandler(deps, { operatorId: OP, uid: u.uid, priorRoles: [] });
    expect(revoke).not.toHaveBeenCalled();

    await deps.db.doc(P.user(OP, u.uid)).update({ status: 'suspended' });
    await syncClaimsHandler(deps, { operatorId: OP, uid: u.uid, priorRoles: ['attendant'] });
    expect(revoke).toHaveBeenCalledExactlyOnceWith(u.uid);
  });
  it('revokes refresh tokens when a role is REMOVED, but not on a lateral/additive change', async () => {
    const deps = testDeps(); await seedOperator(deps);
    const revoke = vi.spyOn(deps.auth, 'revokeRefreshTokens');
    const u = await deps.auth.createUser({ uid: 'att4', email: 'd@x.example.com', password: 'password123' });
    await deps.db.doc(P.user(OP, u.uid)).set({ uid: u.uid, operatorId: OP, roles: ['attendant', 'lead'], venueIds: ['v1'], status: 'active' });
    await syncClaimsHandler(deps, { operatorId: OP, uid: u.uid, priorRoles: [] });

    // additive: gains 'driver' but keeps everything it had — not a reduction, no revoke.
    await deps.db.doc(P.user(OP, u.uid)).update({ roles: ['attendant', 'lead', 'driver'] });
    await syncClaimsHandler(deps, { operatorId: OP, uid: u.uid, priorRoles: ['attendant', 'lead'] });
    expect(revoke).not.toHaveBeenCalled();

    // reduction: loses 'lead' (demoted to attendant+driver only) — revoke.
    await deps.db.doc(P.user(OP, u.uid)).update({ roles: ['attendant', 'driver'] });
    await syncClaimsHandler(deps, { operatorId: OP, uid: u.uid, priorRoles: ['attendant', 'lead', 'driver'] });
    expect(revoke).toHaveBeenCalledExactlyOnceWith(u.uid);
  });
  it('does not revoke refresh tokens on first invite-acceptance (no priorRoles to compare)', async () => {
    const deps = testDeps(); await seedOperator(deps);
    const revoke = vi.spyOn(deps.auth, 'revokeRefreshTokens');
    const u = await deps.auth.createUser({ uid: 'att5', email: 'e@x.example.com', password: 'password123' });
    await deps.db.doc(P.user(OP, u.uid)).set({ uid: u.uid, operatorId: OP, roles: ['attendant'], venueIds: ['v1'], status: 'active' });
    await syncClaimsHandler(deps, { operatorId: OP, uid: u.uid }); // no priorRoles — matches accept.ts's call site
    expect(revoke).not.toHaveBeenCalled();
  });
});
describe('invitations', () => {
  it('admin invites; accept creates auth user + user doc + claims; token single-use; expired rejected', async () => {
    const deps = testDeps(); await seedOperator(deps);
    const { inviteId, token } = await inviteHandler(deps, { uid: 'adm1', operatorId: OP, roles: ['admin'], venueIds: [] }, { email: 'new@x.example.com', roles: ['attendant'], venueIds: ['v1'], displayName: 'New Person' });
    const inv = (await deps.db.doc(P.invitation(inviteId)).get()).data(); expect(inv?.tokenHash).toBeDefined(); expect(inv?.token).toBeUndefined();
    // Normalized to the same shape as the ticket-SMS outbound producer (top-level id + operatorId).
    const outboundDocs = await deps.db.collection('outboundMessages').get();
    expect(outboundDocs.size).toBe(1);
    // vars.inviteeName (not displayName) — Task 1 review Finding M1: must match
    // invitationEmailVarsSchema's real field name, or renderEmail's zod .parse() silently strips it.
    expect(outboundDocs.docs[0]!.data()).toMatchObject({ id: outboundDocs.docs[0]!.id, channel: 'email', operatorId: OP, template: 'invitation', vars: { inviteeName: 'New Person' } });
    const res = await acceptHandler(deps, null, { token, password: 'Str0ngPassw0rd!', displayName: 'New Person' });
    expect(res.operatorId).toBe(OP); expect(res.email).toBe('new@x.example.com'); const user = (await deps.db.doc(P.user(OP, res.uid)).get()).data(); expect(user).toMatchObject({ roles: ['attendant'], venueIds: ['v1'], status: 'active', email: 'new@x.example.com' });
    expect((await deps.auth.getUser(res.uid)).customClaims).toMatchObject({ operatorId: OP, roles: ['attendant'] });
    await expect(acceptHandler(deps, null, { token, password: 'Str0ngPassw0rd!' })).rejects.toMatchObject({ code: 'already_exists' });
    await deps.db.doc(P.invitation(inviteId)).update({ acceptedAt: null, expiresAt: '2020-01-01T00:00:00.000Z' });
    await expect(acceptHandler(deps, null, { token, password: 'Str0ngPassw0rd!' })).rejects.toMatchObject({ code: 'failed_precondition' });
  });
  it('invite without a displayName queues no inviteeName key (conditional spread, not an explicit undefined)', async () => {
    const deps = testDeps(); await seedOperator(deps);
    await inviteHandler(deps, { uid: 'adm1', operatorId: OP, roles: ['admin'], venueIds: [] }, { email: 'noname@x.example.com', roles: ['attendant'], venueIds: [] });
    const outboundDocs = await deps.db.collection('outboundMessages').get();
    const vars = outboundDocs.docs[0]!.data().vars as Record<string, unknown>;
    expect('inviteeName' in vars).toBe(false);
  });
  it('attendant cannot invite; invite of an owner requires owner', async () => {
    const deps = testDeps(); await seedOperator(deps);
    await expect(inviteHandler(deps, { uid: 'a', operatorId: OP, roles: ['attendant'], venueIds: [] }, { email: 'x@x.example.com', roles: ['attendant'], venueIds: [] })).rejects.toMatchObject({ code: 'permission_denied' });
    await expect(inviteHandler(deps, { uid: 'a', operatorId: OP, roles: ['admin'], venueIds: [] }, { email: 'x@x.example.com', roles: ['owner'], venueIds: [] })).rejects.toMatchObject({ code: 'permission_denied' });
  });
  it('signed-in caller with matching auth email binds to caller uid', async () => {
    const deps = testDeps(); await seedOperator(deps);
    const { token } = await inviteHandler(deps, { uid: 'adm1', operatorId: OP, roles: ['admin'], venueIds: [] }, { email: 'match@x.example.com', roles: ['attendant'], venueIds: ['v1'] });
    const authUser = await deps.auth.createUser({ uid: 'caller1', email: 'match@x.example.com', password: 'password123' });
    const res = await acceptHandler(deps, { uid: authUser.uid, roles: [], venueIds: [] }, { token });
    expect(res.uid).toBe(authUser.uid); expect(res.operatorId).toBe(OP); expect(res.email).toBe('match@x.example.com');
    const user = (await deps.db.doc(P.user(OP, authUser.uid)).get()).data();
    expect(user).toMatchObject({ uid: authUser.uid, roles: ['attendant'], venueIds: ['v1'], status: 'active', email: 'match@x.example.com' });
  });
  it('signed-in caller with a different auth email is denied', async () => {
    const deps = testDeps(); await seedOperator(deps);
    const { token } = await inviteHandler(deps, { uid: 'adm1', operatorId: OP, roles: ['admin'], venueIds: [] }, { email: 'invited@x.example.com', roles: ['attendant'], venueIds: [] });
    const authUser = await deps.auth.createUser({ uid: 'caller2', email: 'someone-else@x.example.com', password: 'password123' });
    await expect(acceptHandler(deps, { uid: authUser.uid, roles: [], venueIds: [] }, { token })).rejects.toMatchObject({ code: 'permission_denied' });
  });
  it('signed-in caller with no auth email is denied', async () => {
    const deps = testDeps(); await seedOperator(deps);
    const { token } = await inviteHandler(deps, { uid: 'adm1', operatorId: OP, roles: ['admin'], venueIds: [] }, { email: 'invited2@x.example.com', roles: ['attendant'], venueIds: [] });
    const authUser = await deps.auth.createUser({ uid: 'caller3', password: 'password123' });
    await expect(acceptHandler(deps, { uid: authUser.uid, roles: [], venueIds: [] }, { token })).rejects.toMatchObject({ code: 'permission_denied' });
  });
});
describe('F3 / Ruling G-4a: suspended-operator gate on identityInvite + identityAcceptInvitation', () => {
  it("a suspended operator's owner cannot invite (invite is an ACT, mirroring revoke.ts's Ruling C-2 reasoning)", async () => {
    const deps = testDeps(); await seedOperator(deps);
    await deps.db.doc(P.operator(OP)).update({ status: 'suspended' });
    await expect(
      inviteHandler(deps, { uid: 'own1', operatorId: OP, roles: ['owner'], venueIds: [] }, { email: 'blocked@x.example.com', roles: ['attendant'], venueIds: [] }),
    ).rejects.toMatchObject({ code: 'failed_precondition' });
  });
  it("a platform_admin synthetic caller is exempt — platformCreateOperator's owner-invite on a not-yet-active ('onboarding') operator stays green", async () => {
    const deps = testDeps(); await seedOperator(deps);
    await deps.db.doc(P.operator(OP)).update({ status: 'onboarding' }); // not 'active' — would trip requireActiveOperator if it weren't exempted for a platform_admin caller (it only special-cases 'suspended', but this proves the exemption path is actually taken, not incidentally passing)
    const { inviteId } = await inviteHandler(deps, { uid: 'pa1', operatorId: OP, roles: ['platform_admin'], venueIds: [] }, { email: 'owner@x.example.com', roles: ['owner'], venueIds: [] });
    expect(inviteId).toBeTruthy();
  });
  it("a platform_admin synthetic caller is exempt on a SUSPENDED operator too (the actual production call shape from createOperator.ts's onboarding invite)", async () => {
    const deps = testDeps(); await seedOperator(deps);
    await deps.db.doc(P.operator(OP)).update({ status: 'suspended' });
    const { inviteId } = await inviteHandler(deps, { uid: 'pa1', operatorId: OP, roles: ['platform_admin'], venueIds: [] }, { email: 'owner2@x.example.com', roles: ['owner'], venueIds: [] });
    expect(inviteId).toBeTruthy();
  });
  it('accepting a pre-existing invite issued while the operator was active is denied once the operator is suspended before acceptance', async () => {
    const deps = testDeps(); await seedOperator(deps);
    const { token } = await inviteHandler(deps, { uid: 'adm1', operatorId: OP, roles: ['admin'], venueIds: [] }, { email: 'toosuspended@x.example.com', roles: ['attendant'], venueIds: [] });
    await deps.db.doc(P.operator(OP)).update({ status: 'suspended' });
    await expect(acceptHandler(deps, null, { token, password: 'Str0ngPassw0rd!' })).rejects.toMatchObject({ code: 'failed_precondition' });
  });
});
describe('assume operator', () => {
  it('platform admin gets a custom token with scoped claims; others denied; audited', async () => {
    const deps = testDeps(); await seedOperator(deps);
    const out = await assumeHandler(deps, { uid: 'pa1', roles: ['platform_admin'], venueIds: [] }, { operatorId: OP });
    // The Auth emulator issues unsigned custom tokens (alg: "none"), so the signature segment is empty.
    expect(out.customToken).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/);
    const payload = JSON.parse(Buffer.from(out.customToken.split('.')[1]!, 'base64url').toString()) as { claims: Record<string, unknown> };
    expect(payload.claims.roles).toEqual(['platform_admin', 'admin']); expect(payload.claims.assumedUntil).toBe(Date.parse('2026-08-23T22:00:00.000Z'));
    await expect(assumeHandler(deps, { uid: 'own1', operatorId: OP, roles: ['owner'], venueIds: [] }, { operatorId: OP })).rejects.toMatchObject({ code: 'permission_denied' });
    const logs = await deps.db.collection(`operators/${OP}/auditLog`).where('action', '==', 'identity.assumeOperator').get(); expect(logs.size).toBe(1);
  });
});
describe('guest link', () => {
  it('links open tickets matching the verified phone to guest uid', async () => {
    const deps = testDeps(); await seedOperator(deps);
    await deps.db.doc(P.ticket(OP, TID)).set(ticketDoc()); await deps.db.doc(P.ticket(OP, '01912345-7abc-7def-8123-456789abcde1')).set(ticketDoc({ id: '01912345-7abc-7def-8123-456789abcde1', status: 'closed' }));
    const out = await guestLinkHandler(deps, { uid: 'g1', roles: ['guest'], venueIds: [], phone: '+13175550123' }, {});
    expect(out.linked).toBe(1);
    const ticketAfter = (await deps.db.doc(P.ticket(OP, TID)).get()).data() as { guest: { uid: string } } | undefined;
    expect(ticketAfter?.guest.uid).toBe('g1');
    expect((await deps.db.doc(P.guest('g1')).get()).data()).toMatchObject({ phoneE164: '+13175550123', lastOperatorId: OP });
  });
  it('does not overwrite a ticket already linked to a different guest', async () => {
    const deps = testDeps(); await seedOperator(deps);
    const otherId = '01912345-7abc-7def-8123-456789abcde2';
    await deps.db.doc(P.ticket(OP, TID)).set(ticketDoc());
    await deps.db.doc(P.ticket(OP, otherId)).set(ticketDoc({ id: otherId, guest: { phoneE164: '+13175550123', phoneLast4: '0123', consentSms: true, uid: 'other-guest' } }));
    const out = await guestLinkHandler(deps, { uid: 'g1', roles: ['guest'], venueIds: [], phone: '+13175550123' }, {});
    expect(out.linked).toBe(1);
    const other = (await deps.db.doc(P.ticket(OP, otherId)).get()).data() as { guest: { uid?: string } } | undefined;
    expect(other?.guest.uid).toBe('other-guest');
  });
  it('phone-verified caller with no guest role self-bootstraps roles:[\'guest\'] before linking', async () => {
    const deps = testDeps(); await seedOperator(deps);
    await deps.db.doc(P.ticket(OP, TID)).set(ticketDoc());
    await deps.auth.createUser({ uid: 'g2', phoneNumber: '+13175550123' });
    const out = await guestLinkHandler(deps, { uid: 'g2', roles: [], venueIds: [], phone: '+13175550123' }, {});
    expect(out.linked).toBe(1);
    expect((await deps.auth.getUser('g2')).customClaims).toEqual({ roles: ['guest'], claimsVersion: 1 });
  });
  it('a caller with an operatorId claim (operator staff) is denied — never links or mints the guest role', async () => {
    const deps = testDeps(); await seedOperator(deps);
    await deps.db.doc(P.ticket(OP, TID)).set(ticketDoc());
    await expect(guestLinkHandler(deps, { uid: 'att1', operatorId: OP, roles: ['attendant'], venueIds: [], phone: '+13175550123' }, {})).rejects.toMatchObject({ code: 'permission_denied' });
    const ticketAfter = (await deps.db.doc(P.ticket(OP, TID)).get()).data() as { guest: { uid?: string } } | undefined;
    expect(ticketAfter?.guest.uid).toBeUndefined();
  });
  it('a caller already holding roles:[\'guest\'] links without re-minting claims', async () => {
    const deps = testDeps(); await seedOperator(deps);
    await deps.db.doc(P.ticket(OP, TID)).set(ticketDoc());
    await deps.auth.createUser({ uid: 'g3', phoneNumber: '+13175550123' });
    await deps.auth.setCustomUserClaims('g3', { roles: ['guest'], claimsVersion: 7 });
    const out = await guestLinkHandler(deps, { uid: 'g3', roles: ['guest'], venueIds: [], phone: '+13175550123' }, {});
    expect(out.linked).toBe(1);
    expect((await deps.auth.getUser('g3')).customClaims).toEqual({ roles: ['guest'], claimsVersion: 7 });
  });
  it('first link seeds guest-owned defaults ONCE — consent {sms:true, push:false}, empty savedVehicles/fcmTokens (Ruling AP)', async () => {
    const deps = testDeps(); await seedOperator(deps);
    await deps.db.doc(P.ticket(OP, TID)).set(ticketDoc());
    await guestLinkHandler(deps, { uid: 'g1', roles: ['guest'], venueIds: [], phone: '+13175550123' }, {});
    // push:false, not true: SMS consent is real (the guest handed over a verified phone to get
    // ticket updates); push requires an OS grant the app has not asked for at link time.
    expect((await deps.db.doc(P.guest('g1')).get()).data()).toMatchObject({
      phoneE164: '+13175550123', lastOperatorId: OP, savedVehicles: [], fcmTokens: [], consent: { sms: true, push: false },
    });
  });
  it('relink (the every-cold-launch call) never touches guest-owned fields: a saved vehicle, both devices\' fcmTokens, and an SMS opt-OUT all survive (Ruling AP)', async () => {
    const deps = testDeps(); await seedOperator(deps);
    await deps.db.doc(P.ticket(OP, TID)).set(ticketDoc());
    await guestLinkHandler(deps, { uid: 'g1', roles: ['guest'], venueIds: [], phone: '+13175550123' }, {});
    // The guest acts between launches: saves their car, registers push on phone AND tablet, and
    // opts OUT of SMS. Pre-fix, the next launch's link call reverted ALL THREE with {merge:true}
    // explicitly providing each field — data loss for the first two, a silently-reverted opt-out
    // (TCPA exposure) for the third. This test observes the documented-but-not-yet-executed merge
    // semantics the finding was derived from: emulator, real writes, no mocks.
    await deps.db.doc(P.guest('g1')).set(
      { savedVehicles: [{ plate: 'GST100', state: 'IN' }], fcmTokens: ['tok-phone', 'tok-tablet'], consent: { sms: false, push: true } },
      { merge: true },
    );
    const out = await guestLinkHandler(deps, { uid: 'g1', roles: ['guest'], venueIds: [], phone: '+13175550123' }, {});
    expect(out.linked).toBe(0); // ticket already bound to g1 — relink is a no-op on tickets
    const after = (await deps.db.doc(P.guest('g1')).get()).data() as Record<string, unknown>;
    expect(after.savedVehicles).toEqual([{ plate: 'GST100', state: 'IN' }]);
    expect(after.fcmTokens).toEqual(['tok-phone', 'tok-tablet']);
    expect(after.consent).toEqual({ sms: false, push: true });
    // ...while the fields a relink genuinely owns are still maintained:
    expect(after.phoneE164).toBe('+13175550123');
  });
});
describe('revoke invitation', () => {
  it('admin revokes; the invite reads as expired to acceptHandler; audited', async () => {
    const deps = testDeps(); await seedOperator(deps);
    const { inviteId, token } = await inviteHandler(deps, { uid: 'adm1', operatorId: OP, roles: ['admin'], venueIds: [] }, { email: 'revokeme@x.example.com', roles: ['attendant'], venueIds: [], displayName: 'Revoke Me' });
    const out = await revokeInvitationHandler(deps, { uid: 'adm1', operatorId: OP, roles: ['admin'], venueIds: [] }, { inviteId });
    expect(out).toEqual({ ok: true });
    await expect(acceptHandler(deps, null, { token, password: 'Str0ngPassw0rd!' })).rejects.toMatchObject({ code: 'failed_precondition' });
    const logs = await deps.db.collection(`operators/${OP}/auditLog`).where('action', '==', 'identity.revokeInvitation').get();
    expect(logs.size).toBe(1);
  });
  it('attendant cannot revoke', async () => {
    const deps = testDeps(); await seedOperator(deps);
    const { inviteId } = await inviteHandler(deps, { uid: 'adm1', operatorId: OP, roles: ['admin'], venueIds: [] }, { email: 'x@x.example.com', roles: ['attendant'], venueIds: [] });
    await expect(revokeInvitationHandler(deps, { uid: 'a', operatorId: OP, roles: ['attendant'], venueIds: [] }, { inviteId })).rejects.toMatchObject({ code: 'permission_denied' });
  });
  it('a suspended operator\'s admin is denied — even for an assumed platform_admin (Ruling C-2: revoke is an ACT, no exemption)', async () => {
    const deps = testDeps(); await seedOperator(deps);
    const { inviteId } = await inviteHandler(deps, { uid: 'adm1', operatorId: OP, roles: ['admin'], venueIds: [] }, { email: 'x2@x.example.com', roles: ['attendant'], venueIds: [] });
    await deps.db.doc(P.operator(OP)).update({ status: 'suspended' });
    await expect(revokeInvitationHandler(deps, { uid: 'adm1', operatorId: OP, roles: ['admin'], venueIds: [] }, { inviteId })).rejects.toMatchObject({ code: 'failed_precondition' });
    await expect(revokeInvitationHandler(deps, { uid: 'pa1', operatorId: OP, roles: ['platform_admin'], venueIds: [] }, { inviteId })).rejects.toMatchObject({ code: 'failed_precondition' });
  });
  it('an invitation belonging to a different operator reads as not_found', async () => {
    const deps = testDeps(); await seedOperator(deps);
    const otherOp = 'other-op';
    await deps.db.doc(P.operator(otherOp)).set({ id: otherOp, name: 'Other', slug: otherOp, status: 'active', timezone: 'America/Indiana/Indianapolis', currency: 'USD', isSandbox: false, plan: 'standard', branding: { displayName: 'Other', primaryColor: '#000', accentColor: '#fff' }, modules: { payments: { provider: 'stripe', chargeModel: 'destination', platformFeeBps: 0, tipPresets: [], tipPolicy: 'deliverer' }, messaging: { provider: 'twilio' }, scheduling: { provider: 'internal' }, vision: { provider: 'none' }, accounting: { provider: 'csv' } }, features: { driveHome: true, passengerRides: true, venuePortals: true, tapToPay: false, plateOcr: false, payouts: true }, createdAt: '2026-08-23T21:00:00.000Z', updatedAt: '2026-08-23T21:00:00.000Z', createdBy: 'system' });
    const { inviteId } = await inviteHandler(deps, { uid: 'adm2', operatorId: otherOp, roles: ['admin'], venueIds: [] }, { email: 'other@x.example.com', roles: ['attendant'], venueIds: [] });
    await expect(revokeInvitationHandler(deps, { uid: 'adm1', operatorId: OP, roles: ['admin'], venueIds: [] }, { inviteId })).rejects.toMatchObject({ code: 'not_found' });
  });
  it('an already-accepted invitation cannot be revoked', async () => {
    const deps = testDeps(); await seedOperator(deps);
    const { inviteId, token } = await inviteHandler(deps, { uid: 'adm1', operatorId: OP, roles: ['admin'], venueIds: [] }, { email: 'accepted@x.example.com', roles: ['attendant'], venueIds: [], displayName: 'Already Accepted' });
    await acceptHandler(deps, null, { token, password: 'Str0ngPassw0rd!' });
    await expect(revokeInvitationHandler(deps, { uid: 'adm1', operatorId: OP, roles: ['admin'], venueIds: [] }, { inviteId })).rejects.toMatchObject({ code: 'already_exists' });
  });
});
