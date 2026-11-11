import { onSchedule } from 'firebase-functions/v2/scheduler';
import { makeDeps, type Deps } from '../../lib/deps.js';
import { P } from '../../lib/paths.js';
import { audit } from '../../lib/audit.js';

const ARCHIVED_SUBCOLLECTIONS = ['custodyEvents'] as const;

/**
 * Carry #21: 450, not 500 — Firestore's documented batched-write cap is 500 operations per
 * commit, enforced SERVER-side only (the client sends without a local check, and the EMULATOR
 * does not enforce it at all — verified empirically in this wave's test run, which is why the
 * regression test counts ops per commit through a proxy instead of waiting for a rejection the
 * emulator never issues). Per ticket the archive costs 2 + 2N ops (dest set + copy/delete per
 * custody event + ticket delete), so N = 250 was the first ticket a single batch could not carry.
 * 450 leaves headroom rather than riding the cap.
 */
const BATCH_OP_LIMIT = 450;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

type DocRef = ReturnType<Deps['db']['doc']>;

/**
 * Copies one ticket + its archived subcollections to the archive path, then deletes the source.
 * Chunked (never more than BATCH_OP_LIMIT ops per commit) and crash-ordered: every COPY commits
 * before any DELETE, and the ticket doc's own delete is the last operation of the last batch — so
 * a crash at any point leaves the ticket still `closed`/`cancelled` and re-selectable, the next
 * run's `set`s idempotently overwrite what already copied, and nothing is ever deleted before its
 * copy is durable. (The per-ticket atomicity of the old single batch is deliberately traded away;
 * for a move-then-delete this ordering gives the same safety without the 500-op ceiling.)
 */
async function archiveOne(deps: Deps, d: { id: string; ref: DocRef; data: () => unknown }): Promise<void> {
  const data = d.data() as { operatorId: string };
  const dest = deps.db.doc(P.archiveTicket(data.operatorId, d.id));
  const copies: Array<{ ref: DocRef; data: Record<string, unknown> }> = [{ ref: dest, data: d.data() as Record<string, unknown> }];
  const deletes: DocRef[] = [];
  for (const sub of ARCHIVED_SUBCOLLECTIONS) {
    const subs = await d.ref.collection(sub).get();
    for (const s of subs.docs) {
      copies.push({ ref: dest.collection(sub).doc(s.id), data: s.data() });
      deletes.push(s.ref);
    }
  }
  deletes.push(d.ref); // ticket doc LAST — see the ordering comment above
  for (const group of chunk(copies, BATCH_OP_LIMIT)) {
    const b = deps.db.batch();
    for (const c of group) b.set(c.ref, c.data);
    await b.commit();
  }
  for (const group of chunk(deletes, BATCH_OP_LIMIT)) {
    const b = deps.db.batch();
    for (const ref of group) b.delete(ref);
    await b.commit();
  }
}

export async function archiveHandler(deps: Deps, o: { cutoffDays: number }): Promise<{ archived: number; failed: number }> {
  const cutoff = new Date(Date.parse(deps.now()) - o.cutoffDays * 86_400_000).toISOString();
  let archived = 0;
  let failed = 0;
  for (const status of ['closed', 'cancelled'] as const) {
    const field = status === 'closed' ? 'times.closedAt' : 'times.cancelledAt';
    const q = await deps.db.collectionGroup('tickets').where('status', '==', status).where(field, '<', cutoff).limit(200).get();
    for (const d of q.docs) {
      // Carry #21's real blast radius was this catch's absence: one poison ticket (e.g. a
      // malformed `operatorId` making the archive path invalid) threw out of BOTH status loops,
      // and — the limit(200) query being deterministically path-ordered with no orderBy — was
      // re-selected first on every later run: zero progress, platform-wide, permanently, with
      // `cancelled` tickets never archived at all. Skip-and-count instead; the poison ticket
      // stays in place for a human, named in the log and the audit row's `failed` count.
      try {
        await archiveOne(deps, d);
        archived++;
      } catch (e) {
        failed++;
        console.error('archiveHandler: ticket failed to archive, skipped', {
          path: d.ref.path, status, name: e instanceof Error ? e.name : typeof e,
        });
      }
    }
  }
  // Spans potentially multiple operators (collectionGroup query) — no single operatorId to scope
  // this to, so it lands in the platform-level audit log (P.audit with no operatorId).
  if (archived > 0 || failed > 0) await audit(deps, { actorUid: 'system', action: 'tickets.archive', target: 'archive', after: { archived, failed } });
  return { archived, failed };
}

/**
 * LOAD-BEARING FLOOR: accounting/invoices.ts's `generateInvoices` bills from the LIVE tickets
 * collection, which is correct only while this cutoff exceeds the oldest instant a billable
 * ticket can still be un-invoiced (~62 days: a 31-day period + invoiceDay up to 28 + retry
 * slack). `accounting/invoices.test.ts` guards the inequality — shortening this below the floor
 * fails that test with the undercount named, instead of silently under-billing invoices.
 */
export const ARCHIVE_CUTOFF_DAYS = 90;

export const archiveClosedTickets = onSchedule({ schedule: 'every day 03:00', timeZone: 'America/Indiana/Indianapolis' }, async () => {
  await archiveHandler(makeDeps(), { cutoffDays: ARCHIVE_CUTOFF_DAYS });
});
