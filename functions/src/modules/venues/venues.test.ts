import { beforeEach, describe, expect, it } from 'vitest';
import { venueWrittenHandler } from './venue.handler.js';
import { NOW, OP, V1, seedOperator, testDeps, wipe } from '../../../test/helpers.js';
import { FieldValue } from 'firebase-admin/firestore';
import { P } from '../../lib/paths.js';

beforeEach(async () => {
  await wipe(testDeps());
});

async function readVenue(deps: ReturnType<typeof testDeps>) {
  return (await deps.db.doc(P.venue(OP, V1)).get()).data()!;
}

async function fire(deps: ReturnType<typeof testDeps>, before: Record<string, unknown> | null) {
  const after = await readVenue(deps);
  await venueWrittenHandler(deps, { operatorId: OP, venueId: V1, before, after });
  return readVenue(deps);
}

describe('onVenueWritten', () => {
  it('generates a 22-char staticCheckoutToken once, on create, and never rotates it on a re-fired trigger', async () => {
    const deps = testDeps();
    await seedOperator(deps); // V1 seeded with qr: { staticCheckoutEnabled: false } — no token yet
    const after1 = await fire(deps, null);
    const token1 = (after1.qr as { staticCheckoutToken?: string }).staticCheckoutToken;
    expect(token1).toMatch(/^[A-Za-z0-9_-]{22}$/);

    // Re-fired trigger (retry redelivery, or the write this handler itself just made re-invoking
    // onVenueWritten in production) — same before/after doc, must not mint a second token.
    const after2 = await fire(deps, after1);
    expect((after2.qr as { staticCheckoutToken?: string }).staticCheckoutToken).toBe(token1);
  });

  it('Plan 8 Task 12 (#15): mints a 22-char pushSlug once, alongside the token, and never rotates it (a rotation would unsubscribe every device on shift)', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await deps.db.doc(P.venue(OP, V1)).update({ pushSlug: FieldValue.delete() }); // seedOperator fixes one for producer tests; here we want the mint path
    const after1 = await fire(deps, null);
    const slug1 = after1.pushSlug as string | undefined;
    expect(slug1).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(slug1).not.toBe((after1.qr as { staticCheckoutToken?: string }).staticCheckoutToken); // two independent secrets
    const after2 = await fire(deps, after1);
    expect(after2.pushSlug).toBe(slug1);
  });

  it('writes no venuePublic projection for a disabled venue, even once a token exists', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    const after = await fire(deps, null);
    const token = (after.qr as { staticCheckoutToken: string }).staticCheckoutToken;
    expect((await deps.db.doc(P.venuePublic(token)).get()).exists).toBe(false);
  });

  it('writes a field-complete venuePublic projection when enabled on a flat-rate venue — display-ready branding, rates.valet, tipPresets from op.modules.payments.tipPresets, no secrets', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    const before = await fire(deps, null); // mint the token first (as the real create-write would)
    await deps.db.doc(P.venue(OP, V1)).update({ 'qr.staticCheckoutEnabled': true });
    const after = await fire(deps, before);
    const token = (after.qr as { staticCheckoutToken: string }).staticCheckoutToken;

    const proj = (await deps.db.doc(P.venuePublic(token)).get()).data();
    expect(proj).toStrictEqual({
      operatorId: OP,
      venueId: V1,
      venueName: 'St. Elmo',
      branding: { displayName: 'Goldstar', primaryColor: '#ab6034', accentColor: '#ffc30c', supportPhone: '+13175550100' },
      rates: { valet: { model: 'flat', items: [{ id: 'std', label: 'Valet', amount: 1500 }], taxRateBps: 700, fees: [] } },
      tipPresets: [18, 20, 25],
    });
    // No secrets / operator-internal-only fields anywhere in the doc.
    const json = JSON.stringify(proj);
    expect(json).not.toContain('staticCheckoutToken');
    expect(json).not.toContain('billingEmail');
    expect(json).not.toContain('platformFeeBps');
  });

  it('venueName prefers venue.brandingOverride.displayName over venue.name when set', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await deps.db.doc(P.venue(OP, V1)).update({ 'qr.staticCheckoutEnabled': true, brandingOverride: { displayName: 'The St. Elmo Steak House' } });
    const after = await fire(deps, null);
    const token = (after.qr as { staticCheckoutToken: string }).staticCheckoutToken;
    const proj = (await deps.db.doc(P.venuePublic(token)).get()).data() as { venueName: string };
    expect(proj.venueName).toBe('The St. Elmo Steak House');
  });

  it("Ruling M: never writes a projection for a non-flat model, even when staticCheckoutEnabled is true", async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await deps.db.doc(P.venue(OP, V1)).update({ 'qr.staticCheckoutEnabled': true, 'rates.valet.model': 'hourly' });
    const after = await fire(deps, null);
    const token = (after.qr as { staticCheckoutToken: string }).staticCheckoutToken;
    expect((await deps.db.doc(P.venuePublic(token)).get()).exists).toBe(false);
  });

  it('deletes the venuePublic doc when staticCheckoutEnabled flips back to false', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await deps.db.doc(P.venue(OP, V1)).update({ 'qr.staticCheckoutEnabled': true });
    const enabled = await fire(deps, null);
    const token = (enabled.qr as { staticCheckoutToken: string }).staticCheckoutToken;
    expect((await deps.db.doc(P.venuePublic(token)).get()).exists).toBe(true);

    await deps.db.doc(P.venue(OP, V1)).update({ 'qr.staticCheckoutEnabled': false });
    await fire(deps, enabled);
    expect((await deps.db.doc(P.venuePublic(token)).get()).exists).toBe(false);
  });

  it('deletes the venuePublic doc when the rates model changes away from flat, even if still enabled', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await deps.db.doc(P.venue(OP, V1)).update({ 'qr.staticCheckoutEnabled': true });
    const enabled = await fire(deps, null);
    const token = (enabled.qr as { staticCheckoutToken: string }).staticCheckoutToken;
    expect((await deps.db.doc(P.venuePublic(token)).get()).exists).toBe(true);

    await deps.db.doc(P.venue(OP, V1)).update({ 'rates.valet.model': 'tiered', 'rates.valet.items': [{ id: 't1', label: '0-2h', amount: 1000, upToMinutes: 120 }, { id: 't2', label: 'Day', amount: 3000 }] });
    await fire(deps, enabled);
    expect((await deps.db.doc(P.venuePublic(token)).get()).exists).toBe(false);
  });

  it('cleans up the venuePublic projection when the venue itself is deleted', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await deps.db.doc(P.venue(OP, V1)).update({ 'qr.staticCheckoutEnabled': true });
    const enabled = await fire(deps, null);
    const token = (enabled.qr as { staticCheckoutToken: string }).staticCheckoutToken;
    expect((await deps.db.doc(P.venuePublic(token)).get()).exists).toBe(true);

    await deps.db.doc(P.venue(OP, V1)).delete();
    await venueWrittenHandler(deps, { operatorId: OP, venueId: V1, before: enabled, after: undefined });
    expect((await deps.db.doc(P.venuePublic(token)).get()).exists).toBe(false);
  });

  it('a create event with no prior write (before: null) still mints a token and does nothing else for a disabled venue', async () => {
    const deps = testDeps();
    await seedOperator(deps); // fixture venue has no qr.staticCheckoutToken field at all yet
    const after = await readVenue(deps);
    expect((after.qr as { staticCheckoutToken?: string }).staticCheckoutToken).toBeUndefined();
    await venueWrittenHandler(deps, { operatorId: OP, venueId: V1, before: null, after });
    const updated = await readVenue(deps);
    expect((updated.qr as { staticCheckoutToken?: string }).staticCheckoutToken).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(updated.updatedAt).toBe(NOW); // proves the .update() call actually persisted (testDeps' now() is pinned to NOW)
  });

  it("N3 (final-review.md): a malformed doc missing `qr` entirely logs and returns cleanly — no throw, no token minted, no retry loop", async () => {
    const deps = testDeps();
    await seedOperator(deps); // real venue doc has no staticCheckoutToken yet, updatedAt unset by this handler
    const malformed = { id: V1, operatorId: OP, name: 'No QR Field', type: 'restaurant', status: 'active' }; // no `qr` key at all
    await expect(venueWrittenHandler(deps, { operatorId: OP, venueId: V1, before: null, after: malformed })).resolves.toBeUndefined();
    // proves it short-circuited BEFORE the token-mint write, this handler's only write to the venue
    // doc itself: the real venue doc's staticCheckoutToken is still unminted.
    const stillUnminted = await readVenue(deps);
    expect((stillUnminted.qr as { staticCheckoutToken?: string }).staticCheckoutToken).toBeUndefined();
  });

  it("sign-off micro-fix (final-review.md 'Re-review (final wave)'): a malformed doc missing rates.valet entirely logs and returns cleanly — no throw, no token minted, no retry loop", async () => {
    const deps = testDeps();
    await seedOperator(deps); // real venue doc has no staticCheckoutToken yet
    const malformed = { id: V1, operatorId: OP, name: 'No Rates Field', type: 'restaurant', status: 'active', qr: { staticCheckoutEnabled: false } }; // qr present (clears that guard); no `rates` key at all
    await expect(venueWrittenHandler(deps, { operatorId: OP, venueId: V1, before: null, after: malformed })).resolves.toBeUndefined();
    const stillUnminted = await readVenue(deps);
    expect((stillUnminted.qr as { staticCheckoutToken?: string }).staticCheckoutToken).toBeUndefined();
  });

  it('sign-off micro-fix: same guard fires when `rates` is present but `rates.valet` specifically is missing', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    const malformed = { id: V1, operatorId: OP, name: 'No Rates.Valet', type: 'restaurant', status: 'active', qr: { staticCheckoutEnabled: false }, rates: {} };
    await expect(venueWrittenHandler(deps, { operatorId: OP, venueId: V1, before: null, after: malformed })).resolves.toBeUndefined();
    const stillUnminted = await readVenue(deps);
    expect((stillUnminted.qr as { staticCheckoutToken?: string }).staticCheckoutToken).toBeUndefined();
  });
});
