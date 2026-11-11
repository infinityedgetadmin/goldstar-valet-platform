import type { Invoice, Transaction } from '@goldstar/platform';
import type { Deps } from '../../lib/deps.js';
import type { AccountingProvider } from './port.js';
import { saveWithDownloadUrl } from './storage.js';

/** RFC-4180-enough quoting: wrap when the value contains a comma, quote, or newline. */
function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function csvRows(header: readonly string[], rows: (string | number)[][]): Buffer {
  return Buffer.from([header.join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\n') + '\n', 'utf8');
}

/** `[periodStart, nextPeriodStart)` as ISO instants for a `YYYY-MM` period (UTC month bounds). */
export function periodBounds(period: string): { start: string; end: string } {
  const [y, m] = period.split('-').map(Number) as [number, number];
  const start = new Date(Date.UTC(y, m - 1, 1)).toISOString();
  const end = new Date(Date.UTC(y, m, 1)).toISOString();
  return { start, end };
}

/**
 * Writes the period's two CSVs to `operators/{op}/exports/` (single-segment paths — the
 * storage.rules admin-read match at line 103 covers exactly this shape). Shared by BOTH
 * providers: a CSV export is provider-independent value (the QBO operator still wants files),
 * so `qbo.adapter.ts` delegates here rather than duplicating it.
 *
 * POLARITY: ledger — both files are period-bounded reads (`at`/`period` filters), never a
 * re-read of live state.
 */
export async function writePeriodCsvs(deps: Deps, operatorId: string, period: string): Promise<{ files: { name: string; storagePath: string }[] }> {
  const { start, end } = periodBounds(period);
  const txSnap = await deps.db
    .collection(`operators/${operatorId}/transactions`)
    .where('at', '>=', start)
    .where('at', '<', end)
    .orderBy('at')
    .get();
  const txRows = txSnap.docs.map((d) => {
    const t = d.data() as Transaction;
    const refunded = t.refunds.reduce((s, r) => s + r.amount, 0);
    return [t.at, t.ticketId, t.venueId, t.method, t.base, t.tip, t.tax, t.fees, t.total, refunded, t.destinationAccountId ?? ''];
  });
  const txCsv = csvRows(['date', 'ticket', 'venue', 'method', 'base', 'tip', 'tax', 'fees', 'total', 'refunds', 'destination_account'], txRows);

  const invSnap = await deps.db.collection(`operators/${operatorId}/invoices`).where('period', '==', period).get();
  const invRows = invSnap.docs.map((d) => {
    const i = d.data() as Invoice;
    return [i.id, i.venueId, i.period, i.status, i.subtotal, i.tax, i.total, i.currency, i.sentAt ?? '', i.paidAt ?? ''];
  });
  const invCsv = csvRows(['invoice', 'venue', 'period', 'status', 'subtotal', 'tax', 'total', 'currency', 'sent_at', 'paid_at'], invRows);

  const txName = `transactions-${period}.csv`;
  const invName = `invoices-${period}.csv`;
  await Promise.all([
    saveWithDownloadUrl(deps, `operators/${operatorId}/exports/${txName}`, txCsv, 'text/csv'),
    saveWithDownloadUrl(deps, `operators/${operatorId}/exports/${invName}`, invCsv, 'text/csv'),
  ]);
  return { files: [{ name: txName, storagePath: `operators/${operatorId}/exports/${txName}` }, { name: invName, storagePath: `operators/${operatorId}/exports/${invName}` }] };
}

/**
 * The `csv` accounting provider: exports are the whole product; there is no external ledger, so
 * `syncInvoices` is an HONEST no-op (0 synced, no errors — "nothing to sync to" is not a
 * failure) and `healthCheck` is unconditionally ok (no credentials, no wire).
 */
export class CsvAccountingProvider implements AccountingProvider {
  constructor(private readonly deps: Deps) {}

  exportPeriod(i: { operatorId: string; period: string }): Promise<{ files: { name: string; storagePath: string }[] }> {
    return writePeriodCsvs(this.deps, i.operatorId, i.period);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- port signature (MockPosProvider precedent)
  async syncInvoices(i: { operatorId: string; invoiceIds: string[] }): Promise<{ synced: number; errors: string[] }> {
    void i;
    return { synced: 0, errors: [] };
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- port signature
  async healthCheck(): Promise<{ ok: boolean; message?: string }> {
    return { ok: true };
  }
}
