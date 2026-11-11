import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { TERMINAL_STATUSES, type TicketStatus } from '@goldstar/platform';
import { makeDeps, type Deps } from '../../lib/deps.js';
import { paginateGuestTickets } from './ticketsByGuest.js';

export interface GuestWrittenEvent {
  uid: string;
  before: { consent?: { sms?: boolean } } | null;
  after: { consent?: { sms?: boolean } } | undefined;
}

const CONSENT_PROPAGATION_PAGE_SIZE = 500;
// Fix round 1 ruling (task-platform-report.md): unlike guestDeleteAccount.ts's ticket-unlink walk
// (which must exhaust every page — a legal-obligation completion), THIS is a Firestore TRIGGER —
// it re-fires on every `guests/{uid}` write with no external caller waiting on a bounded result, so
// an unbounded loop here really could run away (a pathological/abuse scenario: a guest doc with an
// enormous historical ticket count toggling consent.sms repeatedly). 20 pages × 500 = 10,000
// lifetime tickets per invocation is far beyond any realistic guest's actual ticket count (this
// query isn't even OPEN-ticket-scoped — see paginateGuestTickets' own comment — it walks every
// ticket the guest ever had, filtering to non-terminal ones in `onPage` below), so this ceiling is
// a defensive backstop against a genuinely unbounded run, not a realistic functional limitation.
const CONSENT_PROPAGATION_MAX_PAGES = 20;

/**
 * Plan 6 (guest account): when a guest changes their SMS consent toggle (`guests/{uid}.consent.sms`),
 * propagate the new value onto `guest.consentSms` for that guest's currently-OPEN tickets — so a
 * mid-visit opt-out (or opt-in) takes effect on the ticket(s) actually driving SMS sends right now
 * (enqueueSms, ticket.handler.ts, reads `t.guest.consentSms`), not just future ones.
 *
 * No recursion guard needed beyond the before/after comparison below: this only ever writes
 * `operators/{op}/tickets/{id}` docs, never back to `guests/{uid}` — there is no cycle through this
 * function's own trigger. It also can't cause a knock-on re-run of ticket.handler.ts's onTicketWritten:
 * that trigger's own `shouldProcessTicketWrite` guard (onTicketWritten.ts) only reacts to
 * status/times/payment/vehicle changes — `guest.consentSms` alone changing is a guaranteed no-op there.
 *
 * Paginated via ticketsByGuest.ts's shared cursor walk (see CONSENT_PROPAGATION_MAX_PAGES above for
 * why this one DOES carry a ceiling, unlike guestDeleteAccount's). Idempotent: a redelivered event
 * (retry: true) re-applies the same value, and already-matching tickets are skipped within each page
 * so a repeat fire over unchanged tickets is a zero-write no-op.
 */
export async function guestWrittenHandler(
  deps: Deps,
  e: GuestWrittenEvent,
  // DI defaults, same convention as maps/autocomplete.ts's `maps` parameter — lets a test exercise
  // the pagination path itself (paginateGuestTickets, ticketsByGuest.ts) — including the maxPages
  // ceiling — with small values instead of needing to seed thousands of real ticket docs.
  pageOpts: { pageSize: number; maxPages: number } = { pageSize: CONSENT_PROPAGATION_PAGE_SIZE, maxPages: CONSENT_PROPAGATION_MAX_PAGES },
): Promise<void> {
  if (!e.after) return; // delete — guests/{uid} is never deletable per firestore.rules, but guard anyway
  const nextSms = e.after.consent?.sms ?? false;
  if (e.before && (e.before.consent?.sms ?? false) === nextSms) return; // no-op guard: only react to an actual consent.sms change
  await paginateGuestTickets(deps, e.uid, pageOpts, async (docs) => {
    const batch = deps.db.batch();
    let n = 0;
    for (const d of docs) {
      const t = d.data() as { status: TicketStatus; guest?: { consentSms?: boolean } };
      if (TERMINAL_STATUSES.includes(t.status)) continue; // OPEN tickets only
      if (t.guest?.consentSms === nextSms) continue; // already matches — skip to keep a repeat fire a zero-write no-op
      batch.update(d.ref, { 'guest.consentSms': nextSms });
      n++;
    }
    if (n > 0) await batch.commit();
    return n;
  });
}

export const onGuestWritten = onDocumentWritten({ document: 'guests/{uid}', retry: true }, async (event) => {
  const before = (event.data?.before.data() as GuestWrittenEvent['before']) ?? null;
  const after = event.data?.after.data() as GuestWrittenEvent['after'];
  await guestWrittenHandler(makeDeps(), { uid: event.params.uid, before, after });
});
