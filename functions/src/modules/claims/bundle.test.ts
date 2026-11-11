import { beforeEach, describe, expect, it } from 'vitest';
import AdmZip from 'adm-zip';
import { createHash } from 'node:crypto';
import type { Caller } from '../../lib/callable.js';
import { PlatformError } from '@goldstar/platform';
import { buildManifest, buildTimelineRows, claimsGenerateBundleHandler } from './bundle.js';
import { NOW, OP, TID, V1, seedOperator, testDeps, ticketDoc, wipe } from '../../../test/helpers.js';
import { P } from '../../lib/paths.js';

// A genuinely decodable 1x1 white-pixel JPEG — pdfkit's `.image()` parses real JPEG headers to
// determine dimensions, so a placeholder/garbage buffer would throw inside the handler under test.
const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=',
  'base64',
);

const RID = '01912345-7abc-7def-8123-456789ab0001';
const CID = '01912345-7abc-7def-8123-456789ab0002';
const PID = '01912345-7abc-7def-8123-456789ab0003';

function claimDoc(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: CID,
    operatorId: OP,
    ticketId: TID,
    status: 'intake',
    reportedAt: NOW,
    description: 'Scratch on rear bumper found at pickup.',
    allegedDamage: [{ panel: 'rear_bumper', kind: 'scratch', description: 'Deep scratch, ~4in' }],
    guestContact: { name: 'Jamie Guest', phone: '+13175550123' },
    createdBy: 'att1',
    createdAt: NOW,
    ...over,
  };
}

function damageReportDoc(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: RID,
    operatorId: OP,
    ticketId: TID,
    vehicleSnapshot: { plate: 'ABC123', make: 'Honda', model: 'Civic', color: 'Blue' },
    phase: 'check_in',
    diagramMarks: [{ panel: 'rear_bumper', x: 0.5, y: 0.5, kind: 'scratch', preExisting: false, note: 'Deep scratch' }],
    notes: 'Noted at check-in',
    createdBy: 'att1',
    createdAt: NOW,
    ...over,
  };
}

function photoDoc(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: PID,
    storagePath: `operators/${OP}/tickets/${TID}/photos/${PID}.jpg`,
    stage: 'close',
    panel: 'rear_bumper',
    at: NOW,
    geo: { lat: 39.765, lng: -86.158 },
    actorUid: 'att1',
    deviceId: 'device1',
    bytes: TINY_JPEG.length,
    width: 1,
    height: 1,
    sha256: createHash('sha256').update(TINY_JPEG).digest('hex'),
    ...over,
  };
}

const ADMIN_CALLER: Caller = { uid: 'admin1', operatorId: OP, roles: ['owner'], venueIds: [] };

async function seedClaimFixture(deps: ReturnType<typeof testDeps>, over: { claim?: Record<string, unknown>; ticket?: Record<string, unknown> } = {}) {
  await seedOperator(deps);
  await deps.db.doc(P.ticket(OP, TID)).set(ticketDoc({ damageReportIds: [RID], guest: { phoneE164: '+13175550123', phoneLast4: '0123', consentSms: true }, ...over.ticket }));
  await deps.db.doc(P.damage(OP, RID)).set(damageReportDoc());
  await deps.db.doc(`operators/${OP}/damageReports/${RID}/photos/${PID}`).set(photoDoc());
  await deps.storage.bucket().file(`operators/${OP}/tickets/${TID}/photos/${PID}.jpg`).save(TINY_JPEG, { contentType: 'image/jpeg' });
  await deps.db.doc(`operators/${OP}/tickets/${TID}/custodyEvents/ce1`).set({ id: 'ce1', actorUid: 'att1', action: 'checked_in', at: NOW, deviceId: 'device1' });
  await deps.db.doc(P.claim(OP, CID)).set(claimDoc(over.claim));
}

beforeEach(async () => {
  await wipe(testDeps());
});

describe('buildTimelineRows', () => {
  it('merges custody events and claim milestones, sorted chronologically', () => {
    const rows = buildTimelineRows({
      claim: claimDoc({ reportedAt: '2026-08-23T20:00:00.000Z' }) as never,
      custodyEvents: [{ id: 'ce1', actorUid: 'att1', action: 'checked_in', at: '2026-08-23T19:00:00.000Z', deviceId: 'd1' } as never],
    });
    expect(rows.map((r) => r.label)).toEqual(['Checked in', 'Claim reported']);
    expect(rows[0]!.at < rows[1]!.at).toBe(true);
  });

  it('includes an insurer-submitted row and an adjudication row when present', () => {
    const rows = buildTimelineRows({
      claim: claimDoc({
        reportedAt: '2026-08-23T18:00:00.000Z',
        status: 'accepted',
        insurer: { carrier: 'Acme Insurance', claimNumber: 'AC-1', submittedAt: '2026-08-23T19:00:00.000Z' },
        adjudication: { notes: 'Approved after review', decidedBy: 'admin1', decidedAt: '2026-08-23T20:00:00.000Z', amount: 5000 },
      }) as never,
      custodyEvents: [],
    });
    expect(rows.map((r) => r.label)).toEqual(['Claim reported', 'Submitted to insurer', 'Claim accepted']);
    expect(rows[1]!.detail).toBe('Acme Insurance · AC-1');
    expect(rows[2]!.detail).toBe('Approved after review');
  });
});

describe('buildManifest', () => {
  it('flattens every photo across every report with damage-report context attached', () => {
    const manifest = buildManifest([{ report: damageReportDoc() as never, photos: [photoDoc() as never] }]);
    expect(manifest).toHaveLength(1);
    expect(manifest[0]).toMatchObject({ id: PID, damageReportId: RID, phase: 'check_in', panel: 'rear_bumper' });
  });

  it('returns an empty array when there are no reports', () => {
    expect(buildManifest([])).toEqual([]);
  });
});

describe('claimsGenerateBundleHandler', () => {
  it('happy path: generates a PDF and ZIP in Storage, writes evidenceBundle on the claim, and audits', async () => {
    const deps = testDeps();
    await seedClaimFixture(deps);

    const out = await claimsGenerateBundleHandler(deps, ADMIN_CALLER, { claimId: CID });
    expect(out).toEqual({ pdfPath: `operators/${OP}/claims/${CID}/evidence.pdf`, zipPath: `operators/${OP}/claims/${CID}/evidence.zip` });

    const [pdfBytes] = await deps.storage.bucket().file(out.pdfPath).download();
    expect(pdfBytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const expectedSha = createHash('sha256').update(pdfBytes).digest('hex');

    // A download token must be present so the dashboard's CLIENT-side getDownloadURL() (a real
    // admin's authenticated request, gated by storage.rules) can resolve a working URL — the Admin
    // SDK's own save() doesn't set one, so the handler must mint it explicitly (see bundle.ts's own
    // comment on why firebase-admin/storage's getDownloadURL() helper can't be used for this instead).
    const [pdfMeta] = await deps.storage.bucket().file(out.pdfPath).getMetadata();
    expect(typeof pdfMeta.metadata?.firebaseStorageDownloadTokens).toBe('string');
    const [zipMeta] = await deps.storage.bucket().file(out.zipPath).getMetadata();
    expect(typeof zipMeta.metadata?.firebaseStorageDownloadTokens).toBe('string');

    const [zipBytes] = await deps.storage.bucket().file(out.zipPath).download();
    const zip = new AdmZip(zipBytes);
    const manifestEntry = zip.getEntry('manifest.json');
    expect(manifestEntry).not.toBeNull();
    const manifest = JSON.parse(zip.readAsText(manifestEntry!)) as { id: string }[];
    expect(manifest).toHaveLength(1);
    expect(manifest[0]!.id).toBe(PID);
    expect(zip.getEntry(`photos/${PID}.jpg`)).not.toBeNull();

    const claim = (await deps.db.doc(P.claim(OP, CID)).get()).data() as { evidenceBundle?: { pdfPath: string; zipPath: string; sha256: string; generatedAt: string } };
    expect(claim.evidenceBundle).toBeDefined();
    expect(claim.evidenceBundle?.pdfPath).toBe(out.pdfPath);
    expect(claim.evidenceBundle?.zipPath).toBe(out.zipPath);
    expect(claim.evidenceBundle?.sha256).toBe(expectedSha);
    expect(claim.evidenceBundle?.generatedAt).toBe(NOW);

    const auditSnap = await deps.db.collection(`operators/${OP}/auditLog`).where('action', '==', 'claims.generateBundle').get();
    expect(auditSnap.size).toBe(1);
    expect(auditSnap.docs[0]!.data()).toMatchObject({ actorUid: 'admin1', target: CID, after: { sha256: expectedSha } });
  });

  it('re-generation overwrites the same two paths rather than versioning them', async () => {
    const deps = testDeps();
    await seedClaimFixture(deps);
    const first = await claimsGenerateBundleHandler(deps, ADMIN_CALLER, { claimId: CID });
    const second = await claimsGenerateBundleHandler(deps, ADMIN_CALLER, { claimId: CID });
    expect(second).toEqual(first);
    // exactly one object at each path — a second generation replaced the content, not added a sibling
    const [files] = await deps.storage.bucket().getFiles({ prefix: `operators/${OP}/claims/${CID}/` });
    expect(files.map((f) => f.name).sort()).toEqual([first.pdfPath, first.zipPath].sort());
  });

  it('non-admin caller (attendant) is denied', async () => {
    const deps = testDeps();
    await seedClaimFixture(deps);
    const attendant: Caller = { uid: 'att1', operatorId: OP, roles: ['attendant'], venueIds: [V1] };
    await expect(claimsGenerateBundleHandler(deps, attendant, { claimId: CID })).rejects.toThrow(PlatformError);
    await expect(claimsGenerateBundleHandler(deps, attendant, { claimId: CID })).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('suspended operator is denied even for an admin caller (unconditional requireActiveOperator, no platform_admin exemption)', async () => {
    const deps = testDeps();
    await seedClaimFixture(deps);
    await deps.db.doc(P.operator(OP)).update({ status: 'suspended' });
    await expect(claimsGenerateBundleHandler(deps, ADMIN_CALLER, { claimId: CID })).rejects.toMatchObject({ code: 'failed_precondition' });
  });

  it('missing claim -> not_found', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await expect(claimsGenerateBundleHandler(deps, ADMIN_CALLER, { claimId: 'nonexistent' })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('a ticket with no damage reports still generates a bundle (empty manifest, no diagrams/photos section)', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await deps.db.doc(P.ticket(OP, TID)).set(ticketDoc());
    await deps.db.doc(P.claim(OP, CID)).set(claimDoc());
    const out = await claimsGenerateBundleHandler(deps, ADMIN_CALLER, { claimId: CID });
    const [zipBytes] = await deps.storage.bucket().file(out.zipPath).download();
    const zip = new AdmZip(zipBytes);
    const manifest = JSON.parse(zip.readAsText(zip.getEntry('manifest.json')!)) as unknown[];
    expect(manifest).toEqual([]);
  });
});
