import { createHash, randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import PDFDocument from 'pdfkit';
import { ZipArchive } from 'archiver';
import { Resvg } from '@resvg/resvg-js';
import type { CallableOutput, CallableParsedInput, Claim, CustodyEvent, DamageReport, Operator, Photo, Ticket, Transaction, Venue } from '@goldstar/platform';
import { claimSchema } from '@goldstar/platform';
import { defineCallable, requireActiveOperator, requireOperator, type Caller } from '../../lib/callable.js';
import type { Deps } from '../../lib/deps.js';
import { err } from '../../lib/errors.js';
import { P } from '../../lib/paths.js';
import { audit } from '../../lib/audit.js';
import { buildDamageDiagramSvg } from './diagram.js';

const PHASE_LABEL: Record<DamageReport['phase'], string> = {
  check_in: 'Check-in',
  check_out: 'Check-out',
  pre_drive: 'Pre-drive',
  post_drive: 'Post-drive',
  incident: 'Incident',
};

interface LoadedClaimData {
  claim: Claim;
  ticket: Ticket;
  venue: Venue | undefined;
  operator: Operator;
  custodyEvents: CustodyEvent[];
  reports: { report: DamageReport; photos: Photo[] }[];
  transactions: Transaction[];
}

/**
 * Loads every piece of evidence the bundle needs, ticket-scoped (not filtered to a subset the claim
 * itself doesn't record — `claimSchema` only carries `ticketId`, not specific report/photo ids), per
 * the brief: "loads ticket, custody events, reports/photos, transactions".
 */
async function loadClaimData(deps: Deps, operatorId: string, operator: Operator, claim: Claim): Promise<LoadedClaimData> {
  const ticketSnap = await deps.db.doc(P.ticket(operatorId, claim.ticketId)).get();
  const ticket = ticketSnap.data() as Ticket | undefined;
  if (!ticket) throw err('not_found', 'ticket not found for claim');

  const [venueSnap, custodySnap, txSnap, reportSnaps] = await Promise.all([
    deps.db.doc(P.venue(operatorId, ticket.venueId)).get(),
    deps.db.collection(`operators/${operatorId}/tickets/${claim.ticketId}/custodyEvents`).orderBy('at', 'asc').get(),
    deps.db.collection(`operators/${operatorId}/transactions`).where('ticketId', '==', claim.ticketId).get(),
    Promise.all(ticket.damageReportIds.map((id) => deps.db.doc(P.damage(operatorId, id)).get())),
  ]);

  const reports = await Promise.all(
    reportSnaps
      .filter((s) => s.exists)
      .map(async (s) => {
        const report = s.data() as DamageReport;
        const photosSnap = await deps.db.collection(`operators/${operatorId}/damageReports/${report.id}/photos`).orderBy('at', 'asc').get();
        return { report, photos: photosSnap.docs.map((d) => d.data() as Photo) };
      }),
  );

  return {
    claim,
    ticket,
    venue: venueSnap.exists ? (venueSnap.data() as Venue) : undefined,
    operator,
    custodyEvents: custodySnap.docs.map((d) => d.data() as CustodyEvent),
    reports,
    transactions: txSnap.docs.map((d) => d.data() as Transaction),
  };
}

const CUSTODY_ACTION_LABEL: Record<CustodyEvent['action'], string> = {
  checked_in: 'Checked in',
  keys_stored: 'Keys stored',
  parked: 'Parked',
  keys_taken: 'Keys taken',
  moved: 'Moved',
  retrieved: 'Retrieved',
  staged: 'Staged',
  delivered: 'Delivered',
  keys_returned: 'Keys returned',
  pre_drive_inspection: 'Pre-drive inspection',
  post_drive_inspection: 'Post-drive inspection',
  handoff_to_chase: 'Handed off to chase',
  note: 'Note',
};

interface TimelineRow {
  at: string;
  label: string;
  detail: string;
}

/**
 * Merges custody events with claim-level milestones (reported / insurer submitted / adjudicated)
 * into one chronological timeline — a claims adjuster cares about the whole story (when the car
 * moved through custody AND when the claim itself progressed), not just one or the other.
 */
export function buildTimelineRows(data: Pick<LoadedClaimData, 'claim' | 'custodyEvents'>): TimelineRow[] {
  const rows: TimelineRow[] = data.custodyEvents.map((e) => ({
    at: e.at,
    label: CUSTODY_ACTION_LABEL[e.action],
    detail: [e.actorUid, e.zoneId, e.spotLabel, e.note].filter(Boolean).join(' · '),
  }));
  rows.push({ at: data.claim.reportedAt, label: 'Claim reported', detail: data.claim.description });
  if (data.claim.insurer) rows.push({ at: data.claim.insurer.submittedAt, label: 'Submitted to insurer', detail: `${data.claim.insurer.carrier} · ${data.claim.insurer.claimNumber}` });
  if (data.claim.adjudication) rows.push({ at: data.claim.adjudication.decidedAt, label: `Claim ${data.claim.status}`, detail: data.claim.adjudication.notes });
  return rows.sort((a, b) => a.at.localeCompare(b.at));
}

interface ManifestPhoto {
  id: string;
  damageReportId: string;
  phase: DamageReport['phase'];
  storagePath: string;
  stage: Photo['stage'];
  panel: Photo['panel'];
  at: string;
  geo: Photo['geo'];
  actorUid: string;
  deviceId: string;
  bytes: number;
  width: number;
  height: number;
  sha256: string;
}

/** Every photo across every damage report on the ticket, flattened for the zip's `manifest.json`. */
export function buildManifest(reports: LoadedClaimData['reports']): ManifestPhoto[] {
  return reports.flatMap(({ report, photos }) =>
    photos.map((p) => ({
      id: p.id,
      damageReportId: report.id,
      phase: report.phase,
      storagePath: p.storagePath,
      stage: p.stage,
      panel: p.panel,
      at: p.at,
      geo: p.geo,
      actorUid: p.actorUid,
      deviceId: p.deviceId,
      bytes: p.bytes,
      width: p.width,
      height: p.height,
      sha256: p.sha256,
    })),
  );
}

function formatGeo(geo: Photo['geo']): string {
  return geo ? `${geo.lat.toFixed(5)},${geo.lng.toFixed(5)}` : 'no location';
}

function photoCaption(p: Photo): string {
  const panel = p.panel ? p.panel.replace(/_/g, ' ') : 'n/a';
  return `${p.stage} · ${panel} · ${p.at} · ${formatGeo(p.geo)} · ${p.sha256.slice(0, 12)}`;
}

const PAGE_MARGIN = 50;
const CONTACT_SHEET_COLS = 2;
const CONTACT_SHEET_ROWS = 3;
const CONTACT_SHEET_PER_PAGE = CONTACT_SHEET_COLS * CONTACT_SHEET_ROWS;

function drawCoverPage(doc: PDFKit.PDFDocument, data: LoadedClaimData, generatedAt: string): void {
  doc.fontSize(20).text('Damage Claim Evidence Bundle', { align: 'left' });
  doc.moveDown(0.5);
  doc.fontSize(10).fillColor('#6b6560');
  doc.text(`Generated ${generatedAt}`);
  doc.moveDown(1);
  doc.fillColor('#0a0807').fontSize(11);

  const rows: [string, string][] = [
    ['Operator', `${data.operator.name} (${data.operator.id})`],
    ['Venue', data.venue ? `${data.venue.name} (${data.venue.id})` : data.ticket.venueId],
    ['Ticket', data.ticket.id],
    ['Claim', data.claim.id],
    ['Claim status', data.claim.status],
    ['Reported at', data.claim.reportedAt],
    ['Vehicle', [data.ticket.vehicle.make, data.ticket.vehicle.model, data.ticket.vehicle.color].filter(Boolean).join(' ') || 'n/a'],
    ['Plate', [data.ticket.vehicle.plate, data.ticket.vehicle.state].filter(Boolean).join(' ') || 'n/a'],
    // Guest LAST4 ONLY — never the full phone (house rule; the callable never even reads phoneE164).
    ['Guest phone', `•••• ${data.ticket.guest.phoneLast4}`],
  ];
  for (const [label, value] of rows) {
    doc.font('Helvetica-Bold').text(`${label}: `, { continued: true }).font('Helvetica').text(value);
  }
  doc.moveDown(1);
  doc.font('Helvetica-Bold').text('Description');
  doc.font('Helvetica').text(data.claim.description);

  if (data.claim.allegedDamage.length > 0) {
    doc.moveDown(1);
    doc.font('Helvetica-Bold').text('Alleged damage');
    doc.font('Helvetica');
    for (const d of data.claim.allegedDamage) {
      doc.text(`• ${d.panel.replace(/_/g, ' ')} — ${d.kind}${d.description ? `: ${d.description}` : ''}`);
    }
  }

  if (data.transactions.length > 0) {
    doc.moveDown(1);
    doc.font('Helvetica-Bold').text('Transactions');
    doc.font('Helvetica');
    for (const t of data.transactions) {
      doc.text(`• ${t.kind} · ${t.status} · ${(t.total / 100).toFixed(2)} ${t.currency} · ${t.at}`);
    }
  }
}

function drawTimelinePage(doc: PDFKit.PDFDocument, rows: TimelineRow[]): void {
  doc.addPage();
  doc.fontSize(16).font('Helvetica-Bold').text('Timeline');
  doc.moveDown(0.5);
  doc.fontSize(9);
  for (const row of rows) {
    doc.font('Helvetica-Bold').text(row.at, { continued: true, width: 500 });
    doc.font('Helvetica').text(`  ${row.label}${row.detail ? ` — ${row.detail}` : ''}`);
  }
}

function renderDiagramPng(report: Pick<DamageReport, 'diagramMarks'>, label: string): Buffer {
  const svg = buildDamageDiagramSvg(report, label);
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: 400 }, background: '#ffffff' });
  return Buffer.from(resvg.render().asPng());
}

function drawDiagramsPage(doc: PDFKit.PDFDocument, reports: LoadedClaimData['reports']): void {
  const withMarks = reports.filter((r) => r.report.diagramMarks.length > 0);
  if (withMarks.length === 0) return;
  doc.addPage();
  doc.fontSize(16).font('Helvetica-Bold').text('Damage diagrams');
  doc.moveDown(0.5);
  let x = PAGE_MARGIN;
  let y = doc.y;
  const boxW = 220;
  const boxH = 300;
  const perRow = 2;
  withMarks.forEach(({ report }, i) => {
    if (i > 0 && i % perRow === 0) {
      x = PAGE_MARGIN;
      y += boxH;
    }
    if (y + boxH > doc.page.height - PAGE_MARGIN) {
      doc.addPage();
      x = PAGE_MARGIN;
      y = PAGE_MARGIN;
    }
    const png = renderDiagramPng(report, PHASE_LABEL[report.phase]);
    doc.image(png, x, y, { fit: [boxW - 10, boxH - 10] });
    x += boxW;
  });
}

/**
 * Downloads a photo's original bytes from Storage for embedding — the bundle needs the actual
 * pixels, not just the Firestore-recorded metadata. Missing objects (shouldn't happen — Storage
 * writes are create-only per `storage.rules`, verified against 1b — are skipped rather than failing
 * the whole bundle, since one corrupted/missing photo shouldn't block generating evidence for the
 * rest of the claim.
 */
async function downloadPhoto(deps: Deps, storagePath: string): Promise<Buffer | undefined> {
  try {
    const [buf] = await deps.storage.bucket().file(storagePath).download();
    return buf;
  } catch {
    return undefined;
  }
}

async function drawContactSheets(doc: PDFKit.PDFDocument, deps: Deps, reports: LoadedClaimData['reports']): Promise<void> {
  const allPhotos = reports.flatMap(({ report, photos }) => photos.map((p) => ({ p, phase: report.phase })));
  if (allPhotos.length === 0) return;

  const usableW = doc.page.width - PAGE_MARGIN * 2;
  const usableH = doc.page.height - PAGE_MARGIN * 2 - 30; // minus heading
  const cellW = usableW / CONTACT_SHEET_COLS;
  const cellH = usableH / CONTACT_SHEET_ROWS;
  const captionH = 42;
  const imgH = cellH - captionH;

  for (let i = 0; i < allPhotos.length; i++) {
    const indexOnPage = i % CONTACT_SHEET_PER_PAGE;
    if (indexOnPage === 0) {
      doc.addPage();
      doc.fontSize(16).font('Helvetica-Bold').text('Photos');
      doc.moveDown(0.3);
    }
    const col = indexOnPage % CONTACT_SHEET_COLS;
    const row = Math.floor(indexOnPage / CONTACT_SHEET_COLS);
    const cellX = PAGE_MARGIN + col * cellW;
    const cellY = PAGE_MARGIN + 30 + row * cellH;

    const { p } = allPhotos[i]!;
    const bytes = await downloadPhoto(deps, p.storagePath);
    // pdfkit throws synchronously on a buffer it can't parse as JPEG/PNG — genuine ticket photos are
    // always real JPEGs (storage.rules' isJpeg() enforces this at upload), but a corrupted/truncated
    // object shouldn't take down the whole bundle for every other photo on the claim.
    const embedded = bytes
      ? (() => {
          try {
            doc.image(bytes, cellX, cellY, { fit: [cellW - 10, imgH - 4], align: 'center' });
            return true;
          } catch {
            return false;
          }
        })()
      : false;
    if (!embedded) {
      doc.fontSize(8).fillColor('#a89f98').text('image unavailable', cellX, cellY + imgH / 2, { width: cellW - 10 });
      doc.fillColor('#0a0807');
    }
    doc.fontSize(7).text(photoCaption(p), cellX, cellY + imgH, { width: cellW - 10 });
  }
}

async function buildPdfBuffer(deps: Deps, data: LoadedClaimData, generatedAt: string): Promise<Buffer> {
  const doc = new PDFDocument({ margin: PAGE_MARGIN, bufferPages: true });
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve, reject) => {
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  doc.pipe(stream);

  drawCoverPage(doc, data, generatedAt);
  drawTimelinePage(doc, buildTimelineRows(data));
  drawDiagramsPage(doc, data.reports);
  await drawContactSheets(doc, deps, data.reports);

  doc.end();
  await done;
  return Buffer.concat(chunks);
}

async function buildZipBuffer(deps: Deps, reports: LoadedClaimData['reports']): Promise<Buffer> {
  const archive = new ZipArchive({ zlib: { level: 9 } });
  const chunks: Buffer[] = [];
  archive.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve, reject) => {
    archive.on('end', resolve);
    archive.on('error', reject);
  });

  const manifest = buildManifest(reports);
  await Promise.all(
    manifest.map(async (m) => {
      const bytes = await downloadPhoto(deps, m.storagePath);
      // Ruling: correction of the brief's literal `photos/{opId}.jpg` naming — every photo in one
      // claim's bundle shares the SAME operator id, so that pattern would collide every photo onto
      // one filename. Keyed by the photo's own id instead (unique per photo, matches manifest.json's
      // `id` field one-to-one). Disclosed deviation — flag if a different naming was intended.
      if (bytes) archive.append(bytes, { name: `photos/${m.id}.jpg` });
    }),
  );
  archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });
  await archive.finalize();
  await done;
  return Buffer.concat(chunks);
}

/**
 * `claimsGenerateBundle` (admin+; task-5-brief.md). Ruling C-2: this WRITES the claim doc and
 * Storage objects (not a pure read), so — mirroring `revealPhone.ts`'s reasoning exactly —
 * `requireActiveOperator` runs UNCONDITIONALLY, with no `platform_admin` exemption. Role set is
 * owner/admin/platform_admin, matching `storage.rules`' `operators/{op}/claims/{claimId}/{file}`
 * read gate (`isAdmin() || isPlatformAdmin()`) and `firestore.rules`' claims create/update gate
 * (`isAdmin()` or `isPlatformAdmin()`) exactly — a caller who can't read the bundle or write the
 * claim shouldn't be able to generate one either.
 *
 * Idempotent re-generation: OVERWRITES the same two paths (`operators/{op}/claims/{id}/evidence.pdf`
 * / `.../evidence.zip`) rather than versioning them. Disclosed trade-off: a browser tab with a
 * previously-fetched download URL open mid-regeneration could momentarily reference stale bytes at
 * that URL until the overwrite completes — accepted, since `getDownloadURL` is resolved on-demand by
 * the evidence panel (not cached across sessions) and versioning would otherwise leave orphaned
 * objects accumulating in Storage on every re-generation with no retention/cleanup story.
 */
export async function claimsGenerateBundleHandler(deps: Deps, caller: Caller | null, input: CallableParsedInput<'claimsGenerateBundle'>): Promise<CallableOutput<'claimsGenerateBundle'>> {
  const c = requireOperator(caller);
  if (!c.roles.some((r) => ['owner', 'admin', 'platform_admin'].includes(r))) throw err('permission_denied');
  const operator = await requireActiveOperator(deps, c.operatorId);

  const claimRef = deps.db.doc(P.claim(c.operatorId, input.claimId));
  const claimSnap = await claimRef.get();
  const parsedClaim = claimSchema.safeParse(claimSnap.data());
  if (!parsedClaim.success) throw err('not_found', 'claim not found');

  const data = await loadClaimData(deps, c.operatorId, operator, parsedClaim.data);
  const generatedAt = deps.now();

  const [pdfBuffer, zipBuffer] = await Promise.all([buildPdfBuffer(deps, data, generatedAt), buildZipBuffer(deps, data.reports)]);
  const sha256 = createHash('sha256').update(pdfBuffer).digest('hex');

  const pdfPath = `operators/${c.operatorId}/claims/${input.claimId}/evidence.pdf`;
  const zipPath = `operators/${c.operatorId}/claims/${input.claimId}/evidence.zip`;
  const bucket = deps.storage.bucket();
  const pdfFile = bucket.file(pdfPath);
  const zipFile = bucket.file(zipPath);
  await Promise.all([pdfFile.save(pdfBuffer, { contentType: 'application/pdf' }), zipFile.save(zipBuffer, { contentType: 'application/zip' })]);
  /**
   * Mints a `firebaseStorageDownloadTokens` metadata token on each object — the Admin SDK's own
   * `save()` does NOT set one, and the dashboard's client-side `getDownloadURL()` (`firebase/storage`)
   * rejects an object that has none.
   *
   * Verified empirically against the Storage emulator (not assumed from memory, per this repo's
   * external-library rule): `firebase-admin/storage`'s own exported `getDownloadURL(file)` helper —
   * which exists specifically to mint/reuse this token — goes through the FIREBASE STORAGE REST proxy
   * (`makeAuthenticatedRequest`, not the raw GCS JSON API), which evaluates `storage.rules` against
   * `request.auth`. An Admin SDK service-account request carries no Firebase Auth ID token, so on this
   * intentionally admin-locked path (`operators/{op}/claims/{claimId}/{file}`'s `isAdmin() ||
   * isPlatformAdmin()` read gate) that helper is DENIED — confirmed this fails the same way against a
   * real project, not just the emulator, since it's a rules evaluation, not an emulator quirk.
   *
   * `file.setMetadata()` (used here instead) is a raw `@google-cloud/storage` object-metadata PATCH —
   * the same GCS-API layer `.save()`/`.download()` use, which genuinely bypasses `storage.rules`
   * (confirmed by the same empirical check) — so this sets the token directly rather than going through
   * the rules-gated helper. The dashboard's own `getDownloadURL()` call is a CLIENT SDK call made by an
   * authenticated admin with a real ID token satisfying the rule, so it resolves the token this sets
   * into a working URL — same mechanism `use-storage-photo-url.ts` already relies on for ticket photos.
   */
  await Promise.all([
    pdfFile.setMetadata({ metadata: { firebaseStorageDownloadTokens: randomUUID() } }),
    zipFile.setMetadata({ metadata: { firebaseStorageDownloadTokens: randomUUID() } }),
  ]);

  const evidenceBundle = { pdfPath, zipPath, generatedAt, sha256 };
  await claimRef.update({ evidenceBundle });
  await audit(deps, { operatorId: c.operatorId, actorUid: c.uid, action: 'claims.generateBundle', target: input.claimId, after: { pdfPath, zipPath, sha256 } });

  return { pdfPath, zipPath };
}

export const claimsGenerateBundle = defineCallable('claimsGenerateBundle', {}, claimsGenerateBundleHandler);
