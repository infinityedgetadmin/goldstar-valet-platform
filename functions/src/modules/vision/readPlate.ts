import { STAFF_ROLES, type CallableOutput, type CallableParsedInput, type Operator, type Ticket } from '@goldstar/platform';
import { defineCallable, requireActiveOperator, requireOperator, requireRole, type Caller } from '../../lib/callable.js';
import type { Deps } from '../../lib/deps.js';
import { err } from '../../lib/errors.js';
import { P } from '../../lib/paths.js';
import { rateLimit } from '../guest/rateLimit.js';
import type { PlateRecognitionProvider } from './port.js';
import { getVision } from './registry.js';

/**
 * Legitimate-use check for the per-uid cap (the same discipline as Task 7's guest limits): an
 * attendant reads at most one plate per check-in and a busy stand turns a car every 1-2 minutes,
 * so 30 reads in 10 minutes is well above any real shift while still bounding a scripted loop
 * against a metered vendor API.
 */
const READS_PER_WINDOW = 30;
const WINDOW_SEC = 600;

/**
 * Plan 8 Task 8: read a plate from an ALREADY-UPLOADED photo. The path must sit under the caller's
 * own operator's tickets tree — a staff token for operator A can never point this at operator B's
 * storage, however the path is spelled. The returning-guest hint reads the operator's most recent
 * ticket for the same plate (index platesByOperator: vehicle.plate ASC, times.checkedInAt DESC) and
 * returns only the phone's last four and where they were last seen — enough to greet a repeat
 * guest, never the number.
 */
export async function visionReadPlateHandler(
  deps: Deps,
  caller: Caller | null,
  input: CallableParsedInput<'visionReadPlate'>,
  provider?: PlateRecognitionProvider,
): Promise<CallableOutput<'visionReadPlate'>> {
  const c = requireOperator(requireRole(caller, [...STAFF_ROLES]));
  const op = await requireActiveOperator(deps, c.operatorId);
  if (!op.features.plateOcr) throw err('failed_precondition', 'plate OCR is not enabled for this operator');
  await rateLimit(deps, `visionReadPlate:${c.uid}`, READS_PER_WINDOW, WINDOW_SEC);
  // Path scoping BEFORE any Storage read: the prefix is the operator's own tickets tree, and a
  // traversal segment anywhere in the path is rejected outright rather than normalised.
  const prefix = `operators/${c.operatorId}/tickets/`;
  if (!input.storagePath.startsWith(prefix) || input.storagePath.split('/').some((seg) => seg === '..' || seg === '')) {
    throw err('permission_denied', 'storagePath outside the caller operator');
  }
  const [bytes] = await deps.storage.bucket().file(input.storagePath).download().catch(() => {
    throw err('not_found', 'photo');
  });
  const vision = provider ?? getVision(deps, op);
  const read = await vision.readPlate({ bytes });
  const knownGuest = read.plate ? await returningGuest(deps, op, read.plate) : undefined;
  return { ...read, ...(knownGuest ? { knownGuest } : {}) };
}

async function returningGuest(deps: Deps, op: Operator, plate: string): Promise<CallableOutput<'visionReadPlate'>['knownGuest'] | undefined> {
  const snap = await deps.db.collection(`operators/${op.id}/tickets`).where('vehicle.plate', '==', plate).orderBy('times.checkedInAt', 'desc').limit(1).get();
  const t = snap.docs[0]?.data() as Ticket | undefined;
  if (!t?.times.checkedInAt) return undefined;
  const venueName = (await deps.db.doc(P.venue(op.id, t.venueId)).get()).data()?.name as string | undefined;
  return { phoneLast4: t.guest.phoneLast4, lastVenueId: t.venueId, lastSeenAt: t.times.checkedInAt, ...(venueName ? { lastVenueName: venueName } : {}) };
}

export const visionReadPlate = defineCallable('visionReadPlate', { secrets: ['PLATE_RECOGNIZER_TOKEN'] }, (deps, caller, input) => visionReadPlateHandler(deps, caller, input));
