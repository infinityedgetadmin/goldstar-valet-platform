import { auditLogEntrySchema, type CallableOutput, type CallableParsedInput } from '@goldstar/platform';
import { defineCallable, requireActiveOperator, requireOperator, type Caller } from '../../lib/callable.js';
import type { Deps } from '../../lib/deps.js';
import { err } from '../../lib/errors.js';

export async function auditQueryHandler(deps: Deps, caller: Caller | null, input: CallableParsedInput<'auditQuery'>): Promise<CallableOutput<'auditQuery'>> {
  const c = requireOperator(caller);
  if (!c.roles.some((r) => ['owner', 'admin', 'platform_admin'].includes(r))) throw err('permission_denied');
  // Ruling C-2: platform_admin (including an assumeOperator session — assume.ts mints
  // roles:['platform_admin','admin']) is exempt here, not gated like the other 6 staff callables.
  // The ORIGINAL Ruling C explicitly required "platform_admin still allowed on a suspended operator —
  // they must be able to reactivate/inspect", and viewing the audit log IS inspecting a suspended
  // operator — the natural way to review what happened before reactivating it. Read-only, no money
  // movement, unlike staffRefund/staffCreateCheckout/staffCancelTicket/terminalConnectionToken/
  // connectOnboardingLink/schedulingSyncNow (the actual "money callables" concern the re-review
  // raised), which stay gated for every caller including an assumed platform_admin — this bypass
  // narrowly applies only here. Disclosed as a judgment call in task-3-report.md; flag if wrong.
  if (!c.roles.includes('platform_admin')) await requireActiveOperator(deps, c.operatorId);
  // Both filters together would require a composite (action, actorUid, at) index that doesn't exist
  // and isn't provisioned — reject at the handler instead of surfacing a confusing FAILED_PRECONDITION.
  if (input.action && input.actorUid) throw err('invalid_argument', 'pass either action or actorUid, not both');
  let q = deps.db.collection(`operators/${c.operatorId}/auditLog`).where('at', '>=', input.from).where('at', '<=', input.to).orderBy('at', 'desc').limit(input.limit);
  if (input.action) q = q.where('action', '==', input.action);
  if (input.actorUid) q = q.where('actorUid', '==', input.actorUid);
  const snap = await q.get();
  // Parse defensively: any writer that bypasses audit() (or a legacy/partial doc) must not take down
  // the whole viewer with one bad row. Drop malformed entries; log only a count, never their content.
  const results = snap.docs.map((d) => auditLogEntrySchema.safeParse(d.data()));
  const dropped = results.filter((r) => !r.success).length;
  if (dropped > 0) console.warn('auditQuery: dropped malformed entries', { count: dropped });
  return { entries: results.flatMap((r) => (r.success ? [r.data] : [])) };
}

export const auditQuery = defineCallable('auditQuery', {}, auditQueryHandler);
