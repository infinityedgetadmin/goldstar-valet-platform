import { INTEGRATION_MANIFEST, type CallableOutput, type CallableParsedInput } from '@goldstar/platform';
import { defineCallable, requireActiveOperator, requireOperator, type Caller } from '../../lib/callable.js';
import type { Deps } from '../../lib/deps.js';
import { err } from '../../lib/errors.js';
import { P } from '../../lib/paths.js';
import { audit } from '../../lib/audit.js';
import { getSecretWriter } from './registry.js';

export async function integrationsSetSecretHandler(
  deps: Deps,
  caller: Caller | null,
  input: CallableParsedInput<'integrationsSetSecret'>,
): Promise<CallableOutput<'integrationsSetSecret'>> {
  const c = requireOperator(caller);
  if (!c.roles.some((r) => r === 'owner' || r === 'platform_admin')) throw err('permission_denied');
  // Ruling C-2 pattern (mirrors audit/query.ts's own disclosed reasoning): an assumed platform_admin
  // session (roles: ['platform_admin', 'admin'] — identity/assume.ts) is exempt from the
  // active-operator gate — a platform admin may legitimately need to fix a suspended operator's
  // integration credentials. An owner is gated normally, same as every other staff-scoped callable.
  if (!c.roles.includes('platform_admin')) await requireActiveOperator(deps, c.operatorId);

  // Task 8/9 (task-89-report.md): the previous rejection here assumed venue-scoped integrations had
  // no Firestore path at all, reasoning about a nested `venues/{v}/integrations/{provider}` match
  // that was never the intended shape. The intended shape — confirmed by re-reading
  // firestore.rules:566's `match /integrations/{provider}` — is a COMPOSITE doc id
  // (`{provider}_{venueId}`) still under the existing `operators/{op}/integrations/{id}` collection.
  // That match is a bare wildcard on the doc id string with no format constraint, so it already
  // covers any id shape, composite ones included — proven directly by
  // test/rules/22-functions-only.test.ts:18-19, which writes/reads an arbitrary non-manifest id
  // ('ical2') through this same rule. So venue-scoped secrets are wired here the same way: the
  // manifest's own `scope` tells us which shape is valid for a given provider.
  const manifestEntry = INTEGRATION_MANIFEST.find((m) => m.id === input.provider);
  // Unreachable in practice — `input.provider` is already constrained to INTEGRATION_IDS by the
  // callable's zod input schema, and INTEGRATION_MANIFEST covers every id in that enum — but `.find`
  // still types as possibly-undefined, so this keeps the narrowing honest instead of a non-null cast.
  if (!manifestEntry) throw err('invalid_argument', 'unknown provider');
  if (input.venueId && manifestEntry.scope !== 'venue') throw err('invalid_argument', 'provider is not venue-scoped');
  if (!input.venueId && manifestEntry.scope === 'venue') throw err('invalid_argument', 'venueId is required for this provider');

  // Safe to compose directly: `input.provider` is already constrained to INTEGRATION_IDS and
  // `input.name` to /^[a-zA-Z0-9_]+$/ by the callable's own zod input schema (defineCallable's
  // safeParse gate runs before this handler); `input.venueId`, when present, is validated above
  // against the manifest but not against a real venue doc — a deliberate, disclosed gap (no
  // extra read added here; the config UI only ever offers a real venue's id in the selector, so a
  // fabricated one just lands on a doc nothing points at, not a security issue). `c.operatorId` is
  // never attacker-free-form — it only ever comes from a real operator doc's id, which is always a
  // slug (^[a-z0-9-]{2,40}$ — same assumption callable.ts's requireActiveOperator doc comment
  // already relies on).
  const docId = input.venueId ? `${input.provider}_${input.venueId}` : input.provider;
  const secretId = `operators-${c.operatorId}-${docId}-${input.name}`;
  await getSecretWriter(deps).setSecret(secretId, input.value);
  const secretRef = secretId;
  await deps.db.doc(P.integration(c.operatorId, docId)).set({ secretRef }, { merge: true });
  // Audits the field NAME only, never input.value — matches every other secret-touching path in this
  // repo (stripeClient.ts/twilioClient.ts never log key material either).
  await audit(deps, { operatorId: c.operatorId, actorUid: c.uid, action: 'integrations.setSecret', target: `${docId}.${input.name}` });
  return { secretRef };
}

export const integrationsSetSecret = defineCallable('integrationsSetSecret', {}, integrationsSetSecretHandler);
