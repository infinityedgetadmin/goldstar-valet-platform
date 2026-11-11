/**
 * Accounting provider port (Plan 7 Task 5). Two implementations: `csv.adapter.ts` (no external
 * system — exports are formatted reads of our own data, `syncInvoices` is an honest no-op) and
 * `qbo.adapter.ts` (QuickBooks Online — every wire contract it uses was verified via Context7
 * before implementation; Ruling AA cut the one call that could not be: `SalesReceipt`).
 *
 * Unlike the POS/PMS ports, an accounting provider is OPERATOR-scoped (one ledger per operator,
 * `operator.modules.accounting.provider`), and it needs read access to our own Firestore data
 * (invoices, venues, transactions) — so adapters take `Deps` at construction rather than being
 * pure HTTP clients.
 */
export interface AccountingProvider {
  /** Writes the period's export files to Storage and returns their paths. */
  exportPeriod(i: { operatorId: string; period: string }): Promise<{ files: { name: string; storagePath: string }[] }>;
  /**
   * Pushes the named invoices to the external ledger. Idempotent per invoice: an invoice already
   * carrying a ledger reference is skipped, never re-created. `errors` carries per-invoice
   * failures (sanitized, no raw provider text) — one bad invoice must not abort the rest.
   */
  syncInvoices(i: { operatorId: string; invoiceIds: string[] }): Promise<{ synced: number; errors: string[] }>;
  healthCheck(): Promise<{ ok: boolean; message?: string }>;
}
