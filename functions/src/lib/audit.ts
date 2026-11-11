import type { Deps } from './deps.js';
import { P } from './paths.js';

export interface AuditInput {
  operatorId?: string;
  actorUid: string;
  action: string;
  target: string;
  before?: unknown;
  after?: unknown;
  ip?: string;
}

export async function audit(deps: Deps, e: AuditInput): Promise<string> {
  const id = deps.newId();
  await deps.db.doc(P.audit(e.operatorId, id)).set({
    id,
    ...e,
    before: e.before ?? null,
    after: e.after ?? null,
    at: deps.now(),
    requestId: deps.requestId,
  });
  return id;
}
