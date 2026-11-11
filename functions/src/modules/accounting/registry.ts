import type { Operator } from '@goldstar/platform';
import type { Deps } from '../../lib/deps.js';
import { err } from '../../lib/errors.js';
import { P } from '../../lib/paths.js';
import type { AccountingProvider } from './port.js';
import { CsvAccountingProvider } from './csv.adapter.js';
import { QboAccountingProvider } from './qbo.adapter.js';

/**
 * Resolves the accounting provider for an OPERATOR (one ledger per operator —
 * `operator.modules.accounting.provider` — unlike the venue-scoped POS/PMS registries). Same
 * spy-friendly `(deps, ...) => Promise<Provider>` shape as `getPos`/`getPms`; Ruling AW applies:
 * health probes and every real call construct through HERE, never a second credential
 * derivation.
 *
 * QBO config lives on the integration doc (`integrations/quickbooks_online`.config —
 * realmId/incomeAccountId per the manifest's configSchema); credentials via the integrations
 * secret convention (`${secretRef}_CLIENT_ID`/`_CLIENT_SECRET`, default `${OP}_QBO` — same
 * module-suffixed default shape as pos's `${OP}_TOAST`; the cross-module naming unification is
 * the standing Task 6 carry). Sandbox routing follows `operator.isSandbox`.
 */
export async function getAccounting(deps: Deps, operator: Operator): Promise<AccountingProvider> {
  const provider = operator.modules.accounting.provider;
  if (provider === 'csv') return new CsvAccountingProvider(deps);
  const integ = (await deps.db.doc(P.integration(operator.id, 'quickbooks_online')).get()).data() as
    | { config?: { realmId?: string; incomeAccountId?: string }; secretRef?: string }
    | undefined;
  const realmId = integ?.config?.realmId;
  const incomeAccountId = integ?.config?.incomeAccountId;
  if (!realmId || !incomeAccountId) throw err('failed_precondition', 'quickbooks not configured for this operator');
  const secretRef = integ.secretRef ?? `${operator.id.toUpperCase()}_QBO`;
  return new QboAccountingProvider(deps, fetch, {
    operatorId: operator.id,
    realmId,
    incomeAccountId,
    clientId: deps.secrets.get(`${secretRef}_CLIENT_ID`),
    clientSecret: deps.secrets.get(`${secretRef}_CLIENT_SECRET`),
    sandbox: operator.isSandbox,
  });
}
