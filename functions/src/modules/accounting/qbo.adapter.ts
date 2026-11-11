import type { Invoice, Venue } from '@goldstar/platform';
import type { Deps } from '../../lib/deps.js';
import { err } from '../../lib/errors.js';
import { P } from '../../lib/paths.js';
import type { AccountingProvider } from './port.js';
import { writePeriodCsvs } from './csv.adapter.js';
import { getQboAccessToken } from './qboToken.js';

// Verified via Context7 (developer.intuit.com, create-a-request + minor-versions) before
// implementation: base hosts, the /v3/company/{realmId}/{entity} path, and minorversion=75.
const PROD_BASE = 'https://quickbooks.api.intuit.com';
const SANDBOX_BASE = 'https://sandbox-quickbooks.api.intuit.com';
const MINOR_VERSION = '75';
/** Adopt-or-suffix bound — after `#5` we fail naming the venue rather than search forever. */
const NAME_SUFFIX_MAX = 5;

/**
 * MONEY BOUNDARY: QBO amounts are DECIMAL DOLLARS (`Amount: 100.00` in every documented
 * payload), while this codebase is INTEGER CENTS. This is the only crossing point — nothing
 * else in the adapter may do arithmetic on a dollar value. Same discipline as
 * pos/toast.adapter.ts, where a missed conversion is a silent 100x error.
 */
function centsToDollars(cents: number): number {
  return Number((cents / 100).toFixed(2));
}

interface QboFault {
  Fault?: { Error?: { code?: string; Message?: string }[] };
}

/**
 * QuickBooks Online accounting provider (Plan 7 Task 5). Everything on the wire here was
 * verified against real documentation before implementation (Context7: base URL + minorversion,
 * token refresh + rotation, customer query SQL, duplicate-name fault 6240, invoice payload from
 * the reconciliation's own verification). Ruling AA cut the ONE unverifiable call
 * (`SalesReceipt`) from Plan 7 entirely — this adapter contains no daily-sales sync and no
 * `syncSalesReceipts` path, deliberately.
 *
 * CUSTOMER/ITEM NAMING (specified in reconciliation §5, not reinvented): QBO enforces
 * `DisplayName`/`Item.Name` uniqueness company-wide. `DisplayName = "{venue.name}
 * ({venue.id.slice(0,8)})"`. On the duplicate-name fault (code 6240): query for the existing
 * entity and ADOPT it if exactly one matches (the idempotent re-run case); if none matches —
 * the name collides with an inactive holder — append ` #2`… bounded at #5, then
 * `failed_precondition` naming the venue. NEVER rename an existing QBO customer when a venue is
 * renamed: the accountant's historical invoices are filed under the old name.
 */
export class QboAccountingProvider implements AccountingProvider {
  constructor(
    private readonly deps: Deps,
    private readonly fetchFn: typeof fetch,
    private readonly config: { operatorId: string; realmId: string; incomeAccountId: string; clientId: string; clientSecret: string; sandbox?: boolean | undefined },
  ) {}

  private base(): string {
    return this.config.sandbox ? SANDBOX_BASE : PROD_BASE;
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const { accessToken } = await getQboAccessToken(this.deps, this.config.operatorId, this.config, this.fetchFn);
    const url = new URL(`${this.base()}/v3/company/${this.config.realmId}${path}`);
    url.searchParams.set('minorversion', MINOR_VERSION);
    const res = await this.fetchFn(url.toString(), {
      method,
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const json = (await res.json().catch(() => ({}))) as T & QboFault;
    if (!res.ok) {
      // Name-only discipline: no raw provider text leaves the adapter. The one fault callers
      // discriminate is duplicate-name (6240) — surfaced as already_exists for adopt-or-suffix.
      const code = json.Fault?.Error?.[0]?.code;
      if (code === '6240') throw err('already_exists', 'duplicate name');
      if (res.status === 401) throw err('failed_precondition', 'quickbooks authorization rejected');
      throw err('provider_unavailable', 'quickbooks request failed');
    }
    return json;
  }

  private async query<T>(q: string): Promise<T[]> {
    const res = await this.request<{ QueryResponse: Record<string, T[] | number | undefined> }>('GET', `/query?query=${encodeURIComponent(q)}`);
    const entity = q.match(/FROM\s+(\w+)/i)?.[1] ?? '';
    return (res.QueryResponse[entity] as T[] | undefined) ?? [];
  }

  /** Adopt-or-suffix per the naming spec above. Returns the QBO id; the CALLER persists it. */
  private async ensureNamedEntity(kind: 'Customer' | 'Item', baseName: string, createBody: (name: string) => Record<string, unknown>): Promise<string> {
    for (let n = 1; n <= NAME_SUFFIX_MAX; n++) {
      const name = n === 1 ? baseName : `${baseName} #${n}`;
      const escaped = name.replace(/'/g, "\\'");
      const existing = await this.query<{ Id: string }>(`SELECT * FROM ${kind} WHERE ${kind === 'Customer' ? 'DisplayName' : 'Name'} = '${escaped}'`);
      if (existing.length === 1) return existing[0]!.Id; // adopt — the idempotent re-run case
      if (existing.length === 0) {
        try {
          const created = await this.request<Record<string, { Id?: string } | undefined>>('POST', `/${kind.toLowerCase()}`, createBody(name));
          const id = created[kind]?.Id;
          if (!id) throw err('provider_unavailable', 'quickbooks create returned no id');
          return id;
        } catch (e) {
          if ((e as { code?: string }).code !== 'already_exists') throw e;
          // 6240 with no queryable match: an INACTIVE holder owns the name — try the next suffix.
        }
      }
      // >1 match: ambiguous — also fall through to the next suffix rather than guessing.
    }
    throw err('failed_precondition', `quickbooks name conflict could not be resolved for ${baseName}`);
  }

  private async ensureCustomer(venue: Venue): Promise<string> {
    if (venue.accounting?.qboCustomerId) return venue.accounting.qboCustomerId;
    const id = await this.ensureNamedEntity('Customer', `${venue.name} (${venue.id.slice(0, 8)})`, (name) => ({ DisplayName: name }));
    await this.deps.db.doc(P.venue(this.config.operatorId, venue.id)).set({ accounting: { ...(venue.accounting ?? {}), qboCustomerId: id } }, { merge: true });
    return id;
  }

  private async ensureItem(venue: Venue): Promise<string> {
    if (venue.accounting?.qboItemId) return venue.accounting.qboItemId;
    const id = await this.ensureNamedEntity('Item', `Valet service (${venue.id.slice(0, 8)})`, (name) => ({
      Name: name,
      Type: 'Service',
      IncomeAccountRef: { value: this.config.incomeAccountId },
    }));
    await this.deps.db.doc(P.venue(this.config.operatorId, venue.id)).set({ accounting: { ...(venue.accounting ?? {}), qboItemId: id } }, { merge: true });
    return id;
  }

  exportPeriod(i: { operatorId: string; period: string }): Promise<{ files: { name: string; storagePath: string }[] }> {
    // Provider-independent value — the QBO operator still wants the files. Shared implementation.
    return writePeriodCsvs(this.deps, i.operatorId, i.period);
  }

  /**
   * Pushes invoices as QBO `Invoice` objects. Idempotent per invoice via the Admin-only
   * `qbo.invoiceId` field on the invoice doc (the posPush precedent: not part of the published
   * schema, read back through a local shape). Per-invoice failures collect into `errors`
   * (sanitized) — one bad invoice never aborts the rest.
   */
  async syncInvoices(i: { operatorId: string; invoiceIds: string[] }): Promise<{ synced: number; errors: string[] }> {
    let synced = 0;
    const errors: string[] = [];
    for (const invoiceId of i.invoiceIds) {
      try {
        const invRef = this.deps.db.doc(P.invoice(i.operatorId, invoiceId));
        const invoice = (await invRef.get()).data() as (Invoice & { qbo?: { invoiceId: string } }) | undefined;
        if (!invoice) {
          errors.push(`${invoiceId}: not found`);
          continue;
        }
        if (invoice.qbo?.invoiceId) continue; // already pushed — idempotent skip, not an error
        const venue = (await this.deps.db.doc(P.venue(i.operatorId, invoice.venueId)).get()).data() as Venue | undefined;
        if (!venue) {
          errors.push(`${invoiceId}: venue not found`);
          continue;
        }
        const [customerId, itemId] = [await this.ensureCustomer(venue), await this.ensureItem(venue)];
        // The payload shape confirmed in the reconciliation's own verification. DECIMAL DOLLARS.
        const created = await this.request<{ Invoice: { Id: string } }>('POST', '/invoice', {
          CustomerRef: { value: customerId },
          TxnDate: `${invoice.period}-01`,
          Line: invoice.lines.map((l) => ({
            DetailType: 'SalesItemLineDetail',
            Amount: centsToDollars(l.amount),
            Description: l.label,
            SalesItemLineDetail: { ItemRef: { value: itemId }, Qty: l.quantity, UnitPrice: centsToDollars(l.unitAmount) },
          })),
        });
        await invRef.set({ qbo: { invoiceId: created.Invoice.Id, syncedAt: this.deps.now() } }, { merge: true });
        synced++;
      } catch (e) {
        errors.push(`${invoiceId}: ${(e as { code?: string }).code ?? 'error'}`);
      }
    }
    return { synced, errors };
  }

  async healthCheck(): Promise<{ ok: boolean; message?: string }> {
    try {
      // A real round-trip: the token refresh path itself (the thing that actually breaks), then
      // the cheapest authenticated read. Ruling AW: constructed only via the registry.
      await this.query('SELECT * FROM CompanyInfo');
      return { ok: true };
    } catch {
      return { ok: false, message: 'quickbooks authentication failed' };
    }
  }
}
