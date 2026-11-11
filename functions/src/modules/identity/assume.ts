import type { CallableParsedInput, CallableOutput } from '@goldstar/platform';
import { defineCallable, requireRole, type Caller } from '../../lib/callable.js';
import type { Deps } from '../../lib/deps.js';
import { err } from '../../lib/errors.js';
import { P } from '../../lib/paths.js';
import { audit } from '../../lib/audit.js';

export async function assumeHandler(deps: Deps, caller: Caller | null, input: CallableParsedInput<'identityAssumeOperator'>): Promise<CallableOutput<'identityAssumeOperator'>> {
  const c = requireRole(caller, ['platform_admin']);
  if (!(await deps.db.doc(P.operator(input.operatorId)).get()).exists) throw err('not_found', 'operator');
  const assumedUntil = Date.parse(deps.now()) + 60 * 60 * 1000; // 1 h; rules reject writes after this
  const customToken = await deps.auth.createCustomToken(c.uid, {
    operatorId: input.operatorId,
    roles: ['platform_admin', 'admin'],
    venueIds: [],
    claimsVersion: 0,
    assumed: true,
    assumedUntil,
  });
  await audit(deps, { operatorId: input.operatorId, actorUid: c.uid, action: 'identity.assumeOperator', target: input.operatorId, ...(c.ip ? { ip: c.ip } : {}) });
  return { customToken };
}

export const identityAssumeOperator = defineCallable('identityAssumeOperator', {}, assumeHandler);
