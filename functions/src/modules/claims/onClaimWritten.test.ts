import { beforeEach, describe, expect, it } from 'vitest';
import { claimWrittenHandler } from './onClaimWritten.js';
import { NOW, OP, TID, seedOperator, testDeps, wipe } from '../../../test/helpers.js';
import { P } from '../../lib/paths.js';

const CID = '01912345-7abc-7def-8123-456789ab0002';

function claimDoc(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: CID,
    operatorId: OP,
    ticketId: TID,
    status: 'intake',
    reportedAt: NOW,
    description: 'Scratch on rear bumper found at pickup.',
    allegedDamage: [],
    guestContact: { name: 'Jamie Guest' },
    createdBy: 'att1',
    createdAt: NOW,
    ...over,
  };
}

async function seedAdmin(deps: ReturnType<typeof testDeps>, uid: string, over: Record<string, unknown> = {}) {
  await deps.db.doc(P.user(OP, uid)).set({ uid, operatorId: OP, displayName: 'Admin', email: `${uid}@goldstar.example.com`, roles: ['admin'], venueIds: [], status: 'active', ...over });
}

beforeEach(async () => {
  await wipe(testDeps());
});

describe('onClaimWritten (claimWrittenHandler)', () => {
  it('a new claim (creation) queues one email per active admin, with claimUpdate vars', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await seedAdmin(deps, 'admin1');
    await claimWrittenHandler(deps, { operatorId: OP, claimId: CID, before: null, after: claimDoc() });

    const snap = await deps.db.collection('outboundMessages').get();
    expect(snap.size).toBe(1);
    const doc = snap.docs[0]!.data();
    expect(doc).toMatchObject({
      channel: 'email',
      operatorId: OP,
      template: 'claimUpdate',
      to: 'admin1@goldstar.example.com',
      status: 'queued',
      vars: { claimId: CID, status: 'intake', guestName: 'Jamie Guest', portalUrl: `https://app.goldstar.example.com/claims/${CID}` },
    });
  });

  it('a real status transition (intake -> under_review) queues a fresh notification', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await seedAdmin(deps, 'admin1');
    await claimWrittenHandler(deps, { operatorId: OP, claimId: CID, before: claimDoc({ status: 'intake' }), after: claimDoc({ status: 'under_review' }) });
    const snap = await deps.db.collection('outboundMessages').get();
    expect(snap.size).toBe(1);
    expect(snap.docs[0]!.data().vars).toMatchObject({ status: 'under_review' });
  });

  it('no status change (e.g. only adjudication notes edited) does not queue anything', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await seedAdmin(deps, 'admin1');
    const before = claimDoc({ status: 'under_review' });
    const after = claimDoc({ status: 'under_review', adjudication: { notes: 'still reviewing', decidedBy: 'admin1', decidedAt: NOW } });
    await claimWrittenHandler(deps, { operatorId: OP, claimId: CID, before, after });
    expect((await deps.db.collection('outboundMessages').get()).size).toBe(0);
  });

  it('redelivered trigger invocation for the same transition does not duplicate the outbound doc', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await seedAdmin(deps, 'admin1');
    await claimWrittenHandler(deps, { operatorId: OP, claimId: CID, before: null, after: claimDoc() });
    const ref = deps.db.doc(`outboundMessages/claim_${CID}_intake_admin1`);
    await ref.update({ status: 'sent' }); // simulate the sender having already delivered it
    await claimWrittenHandler(deps, { operatorId: OP, claimId: CID, before: null, after: claimDoc() }); // redelivered
    expect((await deps.db.collection('outboundMessages').get()).size).toBe(1);
    expect((await ref.get()).data()?.status).toBe('sent');
  });

  it('a lead (not owner/admin) and a suspended admin are both excluded from recipients', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await seedAdmin(deps, 'admin1');
    await seedAdmin(deps, 'lead1', { roles: ['lead'] });
    await seedAdmin(deps, 'admin2', { status: 'suspended' });
    await claimWrittenHandler(deps, { operatorId: OP, claimId: CID, before: null, after: claimDoc() });
    const snap = await deps.db.collection('outboundMessages').get();
    expect(snap.size).toBe(1);
    expect(snap.docs[0]!.data().to).toBe('admin1@goldstar.example.com');
  });

  it('M1 (final whole-branch review): an admin who set notificationPrefs.emailClaims=false is excluded; absent/true still receives it', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await seedAdmin(deps, 'admin1'); // no notificationPrefs at all -> defaults to on
    await seedAdmin(deps, 'admin2', { notificationPrefs: { emailClaims: true, emailCredentials: true, pushRequests: true } });
    await seedAdmin(deps, 'admin3', { notificationPrefs: { emailClaims: false, emailCredentials: true, pushRequests: true } });
    await claimWrittenHandler(deps, { operatorId: OP, claimId: CID, before: null, after: claimDoc() });
    const snap = await deps.db.collection('outboundMessages').get();
    const recipients = snap.docs.map((d) => d.data().to as string).sort();
    expect(recipients).toEqual(['admin1@goldstar.example.com', 'admin2@goldstar.example.com']);
  });

  it('nit: onClaimWritten does not email the admin who made the status change themselves (updatedBy on the raw write)', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await seedAdmin(deps, 'admin1');
    await seedAdmin(deps, 'admin2');
    const before = claimDoc({ status: 'intake' });
    const after = claimDoc({ status: 'under_review', updatedBy: 'admin1' });
    await claimWrittenHandler(deps, { operatorId: OP, claimId: CID, before, after });
    const snap = await deps.db.collection('outboundMessages').get();
    expect(snap.size).toBe(1);
    expect(snap.docs[0]!.data().to).toBe('admin2@goldstar.example.com'); // admin1 (the actor) suppressed
  });

  it('nit: on claim creation, the creator is suppressed via createdBy when no updatedBy is present', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    // The creating admin is themselves an active admin — a real scenario, not contrived.
    await seedAdmin(deps, 'admin1');
    await seedAdmin(deps, 'admin2');
    await claimWrittenHandler(deps, { operatorId: OP, claimId: CID, before: null, after: claimDoc({ createdBy: 'admin1' }) });
    const snap = await deps.db.collection('outboundMessages').get();
    expect(snap.size).toBe(1);
    expect(snap.docs[0]!.data().to).toBe('admin2@goldstar.example.com');
  });

  it('adjudication notes/amount and insurer currency flow into vars when present', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await seedAdmin(deps, 'admin1');
    const after = claimDoc({ status: 'settled', adjudication: { notes: 'Paid out', decidedBy: 'admin1', decidedAt: NOW, amount: 25000 } });
    await claimWrittenHandler(deps, { operatorId: OP, claimId: CID, before: claimDoc({ status: 'accepted' }), after });
    const doc = (await deps.db.collection('outboundMessages').get()).docs[0]!.data();
    expect(doc.vars).toMatchObject({ notes: 'Paid out', amountCents: 25000, currency: 'USD' });
  });

  it('a schema-invalid doc is logged and skipped, not thrown', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await seedAdmin(deps, 'admin1');
    const bad = claimDoc();
    delete (bad as { description?: unknown }).description;
    await expect(claimWrittenHandler(deps, { operatorId: OP, claimId: CID, before: null, after: bad })).resolves.toBeUndefined();
    expect((await deps.db.collection('outboundMessages').get()).size).toBe(0);
  });

  it('a delete event (after undefined) is a no-op', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await seedAdmin(deps, 'admin1');
    await expect(claimWrittenHandler(deps, { operatorId: OP, claimId: CID, before: claimDoc(), after: undefined })).resolves.toBeUndefined();
    expect((await deps.db.collection('outboundMessages').get()).size).toBe(0);
  });
});
