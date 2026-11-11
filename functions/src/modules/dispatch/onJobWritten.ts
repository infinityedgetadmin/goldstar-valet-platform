import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { FieldValue } from 'firebase-admin/firestore';
import { MIN_PRE_DRIVE_PHOTOS, type Operator, type Ticket } from '@goldstar/platform';
import { makeDeps, type Deps } from '../../lib/deps.js';
import { P } from '../../lib/paths.js';
import { audit } from '../../lib/audit.js';
import type { PaymentGateway } from '../payments/port.js';
import { getGateway } from '../payments/registry.js';

export interface JobWrittenEvent {
  operatorId: string;
  ticketId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown>;
}

/**
 * Most branches in `jobWrittenHandler` below react to `after.status` — a same-status field edit is
 * usually a no-op, which self-terminates the in_transit-revert branch's own re-trigger (the revert
 * writes `status:'pre_drive_inspection'`, whose own re-invocation sees `after.status !== 'in_transit'`
 * and does nothing further) without needing a separate recursion flag.
 *
 * ONE deliberate exception (Minor m1, final review, upgraded to this wave): `driveHome.chase.status`
 * reaching `'done'` also needs to reach the handler, to release the chase fleet vehicle at the actual
 * end of the return leg rather than at ticket `completed` (see the handler's own comment on that
 * branch). `chase.status` is written directly by the chase driver's client (gated by
 * firestore.rules' `chaseStepOk`, not by a callable) and never touches the ticket's own `status`
 * field, so it needs its own check here alongside the status-change check. This doesn't reopen a
 * recursion risk: the chase-release branch writes to a DIFFERENT document (`fleetVehicles/{id}`),
 * never back to this ticket, so there's no self-re-trigger to terminate.
 */
export function shouldProcessJobWrite(before: Record<string, unknown> | null, after: Record<string, unknown> | undefined): boolean {
  if (!after) return false;
  if ((after as { jobType?: string }).jobType === 'valet') return false;
  if (!before) return false;
  const b = before as { status?: string; driveHome?: { chase?: { status?: string } } };
  const a = after as { status?: string; driveHome?: { chase?: { status?: string } } };
  if (b.status !== a.status) return true;
  return a.driveHome?.chase?.status !== b.driveHome?.chase?.status;
}

/**
 * Carry #20/#25 (RULED-BUT-UNLANDED until this wave — the ledger recorded the `.count()` design as
 * decided long before it was built; treat that history as the warning it is). The gate counts each
 * report's REAL `photos` subcollection via a count() aggregate, never the denormalized
 * `photoCount` field, for two reasons pinned by the tests:
 *
 * 1. The field's writer was an unguarded `increment(1)` on an at-least-once trigger — a redelivered
 *    event inflated the counter, letting a job pass this SAFETY gate with fewer real photos.
 * 2. The inverted, every-time direction (the "#20/#25 INVERTED" ledger entry): the mobile outbox
 *    writes photo docs through the same Firestore client the ticket screen subscribes on, so
 *    latency compensation un-greys "Start trip" the moment the 4th photo doc exists locally —
 *    2.6–5.7s BEFORE the old trigger could bump the field — and every legitimate start bounced.
 *
 * Counting the subcollection converges with mobile's own client gate (`use-job.ts` counts exactly
 * these docs), so both sides read one source of truth and the trigger drops out of the gate
 * entirely. (What this does NOT claim: photo docs are still client-created and Firestore rules
 * cannot verify the Storage object behind one — four fabricated docs satisfy either design. This
 * closes the trigger-lag and double-count defects, not that insider path.)
 */
async function hasQualifyingReport(deps: Deps, operatorId: string, ticketId: string, phase: 'pre_drive' | 'post_drive'): Promise<boolean> {
  const snap = await deps.db.collection(`operators/${operatorId}/damageReports`).where('ticketId', '==', ticketId).get();
  const candidates = snap.docs.filter((d) => (d.data() as { phase?: string }).phase === phase);
  const counts = await Promise.all(candidates.map(async (d) => (await d.ref.collection('photos').count().get()).data().count));
  return counts.some((c) => c >= MIN_PRE_DRIVE_PHOTOS);
}

async function pushDriver(deps: Deps, operatorId: string, ticketId: string, toUid: string, kind: string, suffix: string): Promise<void> {
  const docId = `dispatch_${suffix}_${ticketId}`;
  await deps.db
    .doc(`pushEvents/${docId}`)
    .create({ id: docId, operatorId, ticketId, kind, data: { ticketId }, toUid, status: 'queued', createdAt: deps.now() })
    .catch((e: unknown) => {
      if ((e as { code?: number }).code !== 6) throw e;
    });
}

function fleetVehicleIdOf(t: Ticket): string | undefined {
  return t.jobType === 'passenger_ride' ? t.vehicle.fleetVehicleId : t.attendants.chaseVehicleId;
}

async function releaseFleetVehicle(deps: Deps, operatorId: string, fleetVehicleId: string): Promise<void> {
  await deps.db.doc(P.fleetVehicle(operatorId, fleetVehicleId)).update({ status: 'available', currentDriverUid: FieldValue.delete() });
}

/**
 * Extends the ticket trigger with dispatch-only side effects that don't belong in the generic
 * `tickets/ticket.handler.ts` (which the payments/dispatch modules already import FROM — putting
 * gateway-capture/cancel logic there would be circular). A SEPARATE `onDocumentWritten` trigger on
 * the same `tickets/{ticketId}` path, gated to non-valet jobs only.
 *
 * Deliberately does NOT handle `cancelled` + `authorized` payment voiding — see
 * `payments/refund.ts`'s `refundRequestedHandler`, fixed (not duplicated) to call the port's new
 * `cancelAuthorization` instead of the F2-guarded `cancelIntent` for that case. The generic
 * cancel-flags-a-refund path (`ticket.handler.ts`) already covers EVERY ticket cancellation,
 * job or valet — building a second, job-specific voiding path here would race it.
 *
 * Also deliberately does NOT copy driver info to the projection on `assigned` — `deriveDriverInfo`
 * (tickets/projection.ts) derives it fresh on every projection rebuild from `attendants.primaryDriverUid`,
 * which `dispatchAssign`'s own `ticketWrittenHandler` call already triggers. A merge-write here would
 * race the NEXT full-overwrite projection rebuild and lose the field — see projection.ts's own
 * comment for the full reasoning.
 */
export async function jobWrittenHandler(deps: Deps, e: JobWrittenEvent, gateway?: PaymentGateway): Promise<void> {
  const after = e.after as unknown as Ticket;
  const before = e.before as unknown as Ticket | null;
  const ref = deps.db.doc(P.ticket(e.operatorId, e.ticketId));

  if (after.status === 'in_transit') {
    const ok = await hasQualifyingReport(deps, e.operatorId, after.id, 'pre_drive');
    if (!ok) {
      await ref.update({ status: 'pre_drive_inspection', 'times.inTransitAt': FieldValue.delete() });
      await audit(deps, { operatorId: e.operatorId, actorUid: 'system', action: 'dispatch.revert_in_transit', target: after.id, before: { status: 'in_transit' }, after: { status: 'pre_drive_inspection' } });
      const primaryUid = after.attendants.primaryDriverUid;
      if (primaryUid) await pushDriver(deps, e.operatorId, after.id, primaryUid, 'dispatch.revert_in_transit', 'revert');
      return;
    }
  }

  if (after.status === 'completed') {
    // Fix round 2 (controller ruling): scoped BACK to drive_home only — fix round 1's "both job
    // types" attempt (Critical #1) was itself wrong. The plan's own T3 ride flow has NO inspection
    // step at all (Assigned -> pickup -> transit -> arrived -> Complete); the spec's inspection gates
    // are §5.2 drive-home specific — the GUEST'S OWN car needs condition evidence before a stranger
    // drives it home, a fleet ride vehicle doesn't carry that same liability shape. Gating
    // passenger_ride identically would have made every ride impossible to complete once mobile
    // ships, since nothing in that flow ever creates a post_drive damageReports doc for a ride.
    // drive_home mirrors the in_transit gate exactly (including its self-terminating recursion: the
    // revert below writes status:'arrived', whose own re-invocation of this handler sees
    // after.status !== 'completed' and does nothing further — no separate guard flag needed).
    if (after.jobType === 'drive_home') {
      const ok = await hasQualifyingReport(deps, e.operatorId, after.id, 'post_drive');
      if (!ok) {
        await ref.update({ status: 'arrived', 'times.completedAt': FieldValue.delete() });
        await audit(deps, { operatorId: e.operatorId, actorUid: 'system', action: 'dispatch.revert_completed', target: after.id, before: { status: 'completed' }, after: { status: 'arrived' } });
        const primaryUid = after.attendants.primaryDriverUid;
        if (primaryUid) await pushDriver(deps, e.operatorId, after.id, primaryUid, 'dispatch.revert_completed', 'revert_completed');
        return;
      }
    }
    // passenger_ride reaches here directly (no gate) and captures unconditionally, same as before
    // fix round 1 ever touched this branch.
    if (after.payment?.status === 'authorized' && after.payment.lastIntentId) {
      // Locals (not `after.payment.total` inline) so the nested transaction closure below doesn't
      // need TS to re-narrow `after.payment` across a function boundary, which it can't.
      const lastIntentId = after.payment.lastIntentId;
      const amount = after.payment.total;
      const captureRef = deps.db.doc(`processedEvents/dispatch_capture_${after.id}`);
      const marker = await captureRef.get();
      if (!marker.exists) {
        const op = (await deps.db.doc(P.operator(e.operatorId)).get()).data() as Operator;
        const gw = gateway ?? getGateway(deps, op);
        // M2 (final review): capture is attempted FIRST — the marker is written only once it
        // resolves. The old code created the marker BEFORE calling `gw.capture`, so any transient
        // failure (Stripe 5xx, network, rate limit) left a marker behind with no capture ever
        // having landed; the trigger's retry:true redelivery then hit the marker and returned
        // early, permanently losing the capture. Here, that same transient failure throws out of
        // this whole block with NO marker written — the redelivery finds the marker still missing
        // and genuinely re-attempts the capture. `gw.capture` itself now treats
        // `payment_intent_unexpected_state` + a retrieved 'succeeded' status as a successful no-op
        // (stripe.adapter.ts, mirroring `cancelAuthorization`'s own retrieve-guard), so a capture
        // that DID land on a prior, crashed invocation resolves here too rather than throwing —
        // making a redelivery after a SUCCESSFUL-but-uncommitted capture safe as well.
        await gw.capture({ providerRef: lastIntentId, amount });
        // Marker + audit commit together in one transaction (Minor m4, final review — the "crash
        // window" note): the old code's early `return` on a marker collision also skipped the
        // fleet-release block below it entirely, and a crash between two separately-awaited writes
        // could durably lose the audit row even after a successful capture. With the marker only
        // ever created here, atomically alongside its audit row, and NO early `return` anywhere in
        // this function, a retry that finds the marker missing safely re-attempts capture (a no-op
        // per the adapter guard above if it already landed) and lands both writes on that later
        // attempt — the fleet-release block below always runs on every invocation regardless.
        await deps.db.runTransaction(async (tx) => {
          const snap = await tx.get(captureRef);
          if (snap.exists) return; // a concurrent invocation already committed this
          tx.create(captureRef, { at: deps.now() });
          const auditId = deps.newId();
          tx.set(deps.db.doc(P.audit(e.operatorId, auditId)), {
            id: auditId,
            operatorId: e.operatorId,
            actorUid: 'system',
            action: 'dispatch.capture',
            target: after.id,
            before: null,
            after: { amount },
            at: deps.now(),
            requestId: deps.requestId,
          });
        });
      }
    }
  }

  if (after.status === 'cancelled') {
    // A cancelled job aborts entirely — release its fleet vehicle immediately regardless of which
    // leg was in progress. Unlike `completed` below, there's no "still driving it back" concern: the
    // trip itself never finishes, so both job types release here exactly as before this wave.
    const fleetVehicleId = fleetVehicleIdOf(after);
    if (fleetVehicleId) await releaseFleetVehicle(deps, e.operatorId, fleetVehicleId);
  }
  if (after.status === 'completed' && after.jobType === 'passenger_ride') {
    const fleetVehicleId = after.vehicle.fleetVehicleId;
    if (fleetVehicleId) await releaseFleetVehicle(deps, e.operatorId, fleetVehicleId);
  }
  // Minor m1 (final review, upgraded to this wave): drive_home's chase vehicle releases when the
  // RETURN LEG itself finishes (`driveHome.chase.status` reaching 'done'), not at ticket `completed`
  // — the old completed-triggered release (removed above) freed the vehicle while the chase driver
  // was still physically driving it back (`chase.status` still 'returning_driver'), letting dispatch
  // double-book it for the length of the return leg. Reachable on a chase-status-only write (the
  // ticket's own `status` field is unchanged) because `shouldProcessJobWrite` above also gates on a
  // `driveHome.chase.status` transition, specifically so this branch runs.
  if (after.jobType === 'drive_home' && after.driveHome?.chase.status === 'done' && before?.driveHome?.chase.status !== 'done') {
    const chaseVehicleId = after.attendants.chaseVehicleId;
    if (chaseVehicleId) await releaseFleetVehicle(deps, e.operatorId, chaseVehicleId);
  }
}

export const onJobWritten = onDocumentWritten({ document: 'operators/{op}/tickets/{ticketId}', retry: true }, async (event) => {
  const afterData: Record<string, unknown> | undefined = event.data?.after.data();
  const beforeData: Record<string, unknown> | null = event.data?.before.data() ?? null;
  if (!afterData || !shouldProcessJobWrite(beforeData, afterData)) return;
  await jobWrittenHandler(makeDeps(), { operatorId: event.params.op, ticketId: event.params.ticketId, before: beforeData, after: afterData });
});
