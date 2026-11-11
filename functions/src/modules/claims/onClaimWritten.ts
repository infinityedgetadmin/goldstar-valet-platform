import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import type { Claim, Operator } from '@goldstar/platform';
import { claimSchema } from '@goldstar/platform';
import { makeDeps, type Deps } from '../../lib/deps.js';
import { P } from '../../lib/paths.js';

const DEFAULT_DASHBOARD_HOST = 'app.goldstar.example.com';

export interface ClaimWriteEvent {
  operatorId: string;
  claimId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | undefined;
}

/**
 * Fires on `operators/{op}/claims/{claimId}` create/update. Task 5 (task-5-brief.md): "email to
 * admins on status change (`claim-update` template)" — the `claimUpdate` email template already
 * exists (`messaging/templates/email/claim-update.ts`, landed under Plan 4b Task 1 ahead of this
 * task, per that file's own header comment) and `messaging/email.ts`'s `renderEmail` already
 * dispatches on `'claimUpdate'`; this trigger is the first (and, per that same header comment, only
 * so far) PRODUCER queuing it.
 *
 * Recipient source: operator admins' emails from `users` docs, one `outboundMessages` doc per admin
 * — the SAME pipeline `identity/eligibility.ts`'s `notifyExpiring` already uses for admin-facing
 * email (owner/admin roles, `status: 'active'`; `messaging/sender.ts`'s `sendOutboundHandler` only
 * processes `channel: 'sms'|'email'` docs, so this needs no new consumer). Disclosed choice, not
 * contract-mandated: the claim's own `guestContact.email` is deliberately NOT notified here — the
 * template's copy ("We've received your damage claim...") reads guest-facing, but nothing in the
 * brief or `claimSchema` marks the guest as a verified recipient of PII-adjacent claim status
 * (settlement amounts), and the schema's `guestContact.email` is optional/staff-entered, not
 * guest-verified the way `ticket.guest.phoneE164` is. Sending only to admins is the safer default;
 * flag if guest notification was actually intended.
 *
 * Idempotency: fires only on a STATUS CHANGE (`before?.status !== after.status` — a brand-new claim
 * has `before === null`, so `undefined !== 'intake'` correctly counts creation as its own "change",
 * matching the template's `intake` copy: "We've received your damage claim"). Every other field edit
 * (adjudication notes without a status change, `evidenceBundle` written by `claimsGenerateBundle`,
 * insurer fields) leaves `status` untouched and is skipped — same status-transition guard shape as
 * `scheduling/tipPool.ts`'s `onShiftWritten`. Per-admin deterministic outbound ids
 * (`claim_{claimId}_{status}_{uid}`) + `.create()` + swallow `ALREADY_EXISTS` (code 6) — this
 * repo's universal redelivery-dedupe convention (`incident.handler.ts`, `identity/eligibility.ts`'s
 * `notifyExpiring`) — so a Firestore-redelivered invocation for the same transition never
 * double-emails the same admin.
 */
export async function claimWrittenHandler(deps: Deps, e: ClaimWriteEvent): Promise<void> {
  if (!e.after) return; // delete
  const beforeStatus = (e.before as { status?: string } | null)?.status;
  const parsed = claimSchema.safeParse(e.after);
  if (!parsed.success) {
    // Never log the raw doc — carries guestContact (name/phone/email). Same "count only" convention
    // as auditQuery's malformed-entry drop / incidentCreatedHandler's schema-fail log.
    console.error('onClaimWritten: schema parse failed', { operatorId: e.operatorId, claimId: e.claimId });
    return;
  }
  const claim: Claim = parsed.data;
  if (claim.status === beforeStatus) return;

  const opSnap = await deps.db.doc(P.operator(e.operatorId)).get();
  const op = opSnap.data() as Operator | undefined;
  if (!op) return;

  const host = process.env.DASHBOARD_HOST ?? DEFAULT_DASHBOARD_HOST;
  const vars: Record<string, unknown> = {
    claimId: claim.id,
    status: claim.status,
    portalUrl: `https://${host}/claims/${claim.id}`,
    ...(claim.guestContact.name !== undefined ? { guestName: claim.guestContact.name } : {}),
    ...(claim.adjudication?.notes !== undefined ? { notes: claim.adjudication.notes } : {}),
    ...(claim.adjudication?.amount !== undefined ? { amountCents: claim.adjudication.amount, currency: op.currency } : {}),
  };

  // Nit (final whole-branch review): don't email the admin who just made this change themselves —
  // pure noise, not harm, but cheap to suppress. The claim schema has no general "who changed
  // status" field (`adjudication.decidedBy` only covers the accept/deny/settle notes write, a
  // SEPARATE mutation from the status transition itself — `claim-detail.tsx`'s `AdjudicationForm`
  // and `StatusActions` are deliberately decoupled, per that file's own header comment). The
  // dashboard's `StatusActions.setStatus` now stamps an `updatedBy` field alongside `status` on
  // every transition; read it off the RAW `e.after` (before `claimSchema.safeParse` strips unknown
  // keys — `updatedBy` is deliberately not part of the schema, so it never round-trips through the
  // typed `Claim`, the same way `processedEvents` docs carry handler-only fields no schema owns).
  // Claim CREATION has no `updatedBy` (the dashboard's intake dialog doesn't set it) — `createdBy`
  // is the actor there instead.
  const actorUid = (e.after as { updatedBy?: string }).updatedBy ?? (beforeStatus === undefined ? claim.createdBy : undefined);

  const admins = await deps.db.collection(`operators/${e.operatorId}/users`).where('roles', 'array-contains-any', ['owner', 'admin']).where('status', '==', 'active').get();
  await Promise.all(
    admins.docs
      .filter((a) => a.id !== actorUid)
      // M1 (final whole-branch review): `notificationPrefs.emailClaims` was written by the settings
      // page (T8) but never read by any sender — the toggle was a placebo. Absent (field never set,
      // or the whole `notificationPrefs` object never written) defaults to on, matching every
      // admin's behavior before the settings page existed.
      .filter((a) => (a.data() as { notificationPrefs?: { emailClaims?: boolean } }).notificationPrefs?.emailClaims !== false)
      .map((a) => {
        const admin = a.data() as { email: string };
        const id = `claim_${claim.id}_${claim.status}_${a.id}`;
        return deps.db
          .doc(P.outbound(id))
          .create({ id, channel: 'email', operatorId: e.operatorId, template: 'claimUpdate', to: admin.email, vars, status: 'queued', attempts: 0, createdAt: deps.now() })
          .catch((err: unknown) => {
            if ((err as { code?: number }).code !== 6) throw err;
          });
      }),
  );
}

// retry: true — claimWrittenHandler's only side effect is the deterministic-id outboundMessages
// .create() (dedupe via ALREADY_EXISTS swallow), so a crash-then-redelivery self-heals instead of
// silently dropping the admin notification (same reasoning as onIncidentCreated.ts / onShiftWritten).
export const onClaimWritten = onDocumentWritten({ document: 'operators/{op}/claims/{claimId}', retry: true }, async (event) => {
  const afterData = event.data?.after.data() as Record<string, unknown> | undefined;
  const beforeData = (event.data?.before.data() as Record<string, unknown> | undefined) ?? null;
  await claimWrittenHandler(makeDeps(), { operatorId: event.params.op, claimId: event.params.claimId, before: beforeData, after: afterData });
});
