import { onSchedule } from 'firebase-functions/v2/scheduler';
import type { CallableOutput, CallableParsedInput, Operator } from '@goldstar/platform';
import { defineCallable, requireActiveOperator, requireOperator, type Caller } from '../../lib/callable.js';
import { makeDeps, type Deps } from '../../lib/deps.js';
import { err } from '../../lib/errors.js';
import { P } from '../../lib/paths.js';
import { getScheduleProvider } from './registry.js';
import { upsertExternalShifts } from './upsert.js';

export async function syncOperator(deps: Deps, op: Operator): Promise<{ upserted: number; errors: string[] }> {
  const kind = op.modules.scheduling.provider; if (kind === 'internal') return { upserted: 0, errors: [] };
  const integ = (await deps.db.doc(P.integration(op.id, kind)).get()).data() as { config?: Record<string, unknown>; secretRef?: string } | undefined;
  const ctx = { deps, operatorId: op.id, config: { ...(op.modules.scheduling.config ?? {}), ...(integ?.config ?? {}) }, secret: (n: string) => deps.secrets.get(`${integ?.secretRef ?? op.id.toUpperCase()}_${n}`) };
  const from = new Date(Date.parse(deps.now()) - 86_400_000).toISOString().slice(0, 10); const to = new Date(Date.parse(deps.now()) + 14 * 86_400_000).toISOString().slice(0, 10);
  try {
    const res = await getScheduleProvider(kind).sync(ctx, { from, to }); const up = await upsertExternalShifts(deps, op.id, kind, res.shifts);
    await deps.db.doc(P.integration(op.id, kind)).set({ lastSyncAt: deps.now(), health: { ok: up.errors.length === 0, errors: up.errors.slice(0, 20) } }, { merge: true });
    return { upserted: up.upserted, errors: [...res.errors, ...up.errors] };
  } catch (e) {
    await deps.db.doc(P.integration(op.id, kind)).set({ lastError: (e as Error).message.slice(0, 300), lastErrorAt: deps.now(), health: { ok: false } }, { merge: true });
    return { upserted: 0, errors: [(e as Error).message] };
  }
}

export const syncAllOperators = onSchedule({ schedule: 'every 15 minutes' }, async () => {
  const deps = makeDeps(); const ops = await deps.db.collection('operators').where('status', '==', 'active').get();
  for (const d of ops.docs) await syncOperator(deps, d.data() as Operator);
});

export async function schedulingSyncNowHandler(deps: Deps, caller: Caller | null, input: CallableParsedInput<'schedulingSyncNow'>): Promise<CallableOutput<'schedulingSyncNow'>> {
  void input; // schedulingSyncNow takes no input (z.object({})); kept as a 3rd param to match defineCallable's handler shape and staffRefundHandler-style direct-call testing
  const c = requireOperator(caller); if (!c.roles.some((r) => ['owner', 'admin'].includes(r))) throw err('permission_denied');
  const op = (await deps.db.doc(P.operator(c.operatorId)).get()).data() as Operator;
  await requireActiveOperator(deps, c.operatorId, op); // Ruling C-2 — zero extra read, op already fetched above
  return syncOperator(deps, op);
}

export const schedulingSyncNow = defineCallable('schedulingSyncNow', {}, schedulingSyncNowHandler);
