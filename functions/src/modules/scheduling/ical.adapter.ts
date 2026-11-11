import ICAL from 'ical.js';
import type { Role } from '@goldstar/platform';
import type { ExternalShift, ProviderContext, ScheduleProvider, SyncResult } from './port.js';

const EMAIL_RE = /email:\s*(\S+@\S+)/i;
const LEAD_RE = /lead/i;

interface ICalConfig {
  feedUrl: string;
  venueId: string;
  matchBy: 'email' | 'name';
}

function readConfig(config: Record<string, unknown>): ICalConfig {
  return {
    feedUrl: config.feedUrl as string,
    venueId: config.venueId as string,
    matchBy: (config.matchBy as ICalConfig['matchBy'] | undefined) ?? 'email',
  };
}

/** Strips a `mailto:` prefix (case-insensitive) — jCal's `cal-address` value type always carries
 * one, verified against `ical.js`'s own jCal output samples. */
function stripMailto(value: string): string {
  return value.replace(/^mailto:/i, '').trim();
}

/**
 * `ICalScheduleProvider` (Plan 7 Task 4, brief unchanged per the reconciliation — this is the
 * fully-unblocked half of T4, no external contract to verify). Maps `SUMMARY`/`ATTENDEE` (or a
 * `DESCRIPTION` line reading `email: ...` when no ATTENDEE is present) to `ExternalShift` for the
 * feed's one configured `venueId`. Role is `attendant` unless the event's `SUMMARY` contains
 * "lead" (case-insensitive), applying to every attendee on that event — the brief describes a
 * per-event distinction, not a per-attendee one, and there's no separate lead-designation source
 * in the iCal format to draw a finer line from.
 *
 * Recurring events expand via `ical.js`'s own `RecurExpansion` (confirmed against the installed
 * library, not assumed — see the adapter's own test file for the worked 3-events/5-shifts case
 * the brief specifies). Each OCCURRENCE of a recurring event needs its own distinct
 * `externalId` — `upsertExternalShifts` keys the Firestore doc as `${provider}_${externalId}`,
 * so reusing the bare `UID` across three weekly occurrences would collide all three into one
 * doc. `externalId` is `${UID}#${occurrence date}` for a recurring event, bare `UID` for a
 * single one (never `#`-suffixed, so re-running with the same feed content produces the same
 * ids either way).
 *
 * `date`/`startsAt`/`endsAt` are read straight through `ICAL.Time.toJSDate()`'s own UTC/TZID
 * handling (the library's whole job, not reimplemented here) — `date` is the UTC calendar date
 * of the occurrence's start. There is no per-feed timezone config in the `ical` manifest entry
 * (`feedUrl`/`venueId`/`matchBy` only) to interpret it in any other zone; disclosed simplification
 * in the task report, not a silent assumption.
 *
 * `matchBy: 'name'` (disclosed design decision — the brief names the option but not its exact
 * mechanics): every `operators/{op}/users` doc is read ONCE per sync (mirroring
 * `upsertExternalShifts`'s own map-building pattern — this adapter runs before that pipeline
 * step and has no access to its maps) into a case-insensitive name index. Each event's ATTENDEE
 * `CN` parameter (or, with no ATTENDEE, the SUMMARY text itself) is looked up against it; on a
 * match, the assignment carries that user's real `email` — so it flows through the SAME
 * `email`-keyed resolution `upsertExternalShifts` already does downstream, no adapter-specific
 * field needed. An unresolved name is reported into `SyncResult.errors` (not thrown, not
 * silently dropped) and the shift is still produced with that one assignment omitted — the SAME
 * "report, don't drop the shift" doctrine `upsertExternalShifts` already uses for an unmatched
 * email.
 *
 * `RECURRENCE-ID` overrides (fix round 1, M2 — a dragged single occurrence, the most common real
 * edit to a recurring series in Google Calendar and similar): `ICAL.RecurExpansion` on the MASTER
 * VEVENT has no idea an override exists — it naively expands the RRULE for every date, including
 * ones a `RECURRENCE-ID` VEVENT has superseded. `getAllSubcomponents('vevent')` returns each
 * override as its OWN top-level entry sharing the master's UID (`ICAL.Event.isRecurrenceException()`
 * is true for it, `isRecurring()` is false — it carries no RRULE of its own). A pre-pass collects
 * every `{uid -> Set<original slot date>}` from `RECURRENCE-ID` VEVENTs BEFORE the main loop; the
 * master's expansion skips any date in that set for its own UID, and each override gets
 * `externalId = ${uid}#${recurrenceIdDate}` — keyed by the SLOT IT REPLACES (not its own, possibly
 * moved, date), matching the master's skip-set exactly and staying idempotent across re-syncs — but
 * its actual `startsAt`/`endsAt`/`date` come from its OWN `DTSTART`/`DTEND` (the moved time).
 */
export class ICalScheduleProvider implements ScheduleProvider {
  kind = 'ical';

  constructor(private readonly fetchFn: typeof fetch = fetch) {}

  private async fetchCalendar(feedUrl: string): Promise<{ text: string; status: number }> {
    const res = await this.fetchFn(feedUrl);
    return { text: await res.text(), status: res.status };
  }

  async sync(ctx: ProviderContext, range: { from: string; to: string }): Promise<SyncResult> {
    const config = readConfig(ctx.config);
    let text: string;
    try {
      const res = await this.fetchCalendar(config.feedUrl);
      if (res.status !== 200) return { upserted: 0, errors: [`feed fetch failed: HTTP ${res.status}`], shifts: [] };
      text = res.text;
    } catch (e) {
      return { upserted: 0, errors: [(e as Error).message], shifts: [] };
    }

    let comp: ICAL.Component;
    try {
      // ICAL.parse's own .d.ts returns `any` ("todo: fix the API to be more clear on the return
      // type"). Cast to the Component constructor's actual declared param type (`string |
      // unknown[]`, not `any`) so this stays `any`-free rather than passing an `any`-typed value
      // straight through.
      const jcalData = ICAL.parse(text) as string | unknown[];
      comp = new ICAL.Component(jcalData);
    } catch (e) {
      return { upserted: 0, errors: [`feed did not parse as iCalendar: ${(e as Error).message}`], shifts: [] };
    }

    const byName =
      config.matchBy === 'name'
        ? new Map(
            (await ctx.deps.db.collection(`operators/${ctx.operatorId}/users`).get()).docs
              .map((d) => d.data() as { name?: string; email?: string })
              .filter((u): u is { name: string; email: string } => !!u.name && !!u.email)
              .map((u) => [u.name.trim().toLowerCase(), u.email]),
          )
        : null;

    const fromMs = Date.parse(`${range.from}T00:00:00.000Z`);
    const toMs = Date.parse(`${range.to}T23:59:59.999Z`);
    const shifts: ExternalShift[] = [];
    const errors: string[] = [];

    // M2 pre-pass: collect every RECURRENCE-ID override's ORIGINAL slot date per UID, so the
    // master's expansion below can skip it and each override can key off the same date.
    const overrideDatesByUid = new Map<string, Set<string>>();
    for (const vevent of comp.getAllSubcomponents('vevent')) {
      const event = new ICAL.Event(vevent);
      if (!event.isRecurrenceException()) continue;
      const recurrenceId = event.recurrenceId as ICAL.Time | null;
      if (!recurrenceId) continue;
      const dateStr = recurrenceId.toJSDate().toISOString().slice(0, 10);
      const set = overrideDatesByUid.get(event.uid) ?? new Set<string>();
      set.add(dateStr);
      overrideDatesByUid.set(event.uid, set);
    }

    for (const vevent of comp.getAllSubcomponents('vevent')) {
      const event = new ICAL.Event(vevent);
      const uid = event.uid;
      // ical.js's bundled .d.ts claims `summary`/`startDate`/`endDate` are always non-null, but the
      // runtime getters (event.js's `_firstProp` -> `component.getFirstPropertyValue`) return
      // `null` when the property is simply absent from the VEVENT — verified against the installed
      // library's own source, not just its (here, inaccurate) type declarations. Cast to the real,
      // nullable runtime type rather than trusting the `.d.ts`.
      const summary = (event.summary as string | null) ?? '';
      const role: Role = LEAD_RE.test(summary) ? 'lead' : 'attendant';
      const { assignments, assignmentErrors } = this.resolveAssignments(vevent, summary, byName, role);
      errors.push(...assignmentErrors.map((e) => `${e} on ${uid}`));

      const startDateForDuration = event.startDate as ICAL.Time | null;
      const endDateForDuration = event.endDate as ICAL.Time | null;
      const durationMs =
        endDateForDuration && startDateForDuration ? endDateForDuration.toJSDate().getTime() - startDateForDuration.toJSDate().getTime() : 0;

      if (!event.isRecurring()) {
        const start = event.startDate.toJSDate();
        if (start.getTime() < fromMs || start.getTime() > toMs) continue;
        // M2: a RECURRENCE-ID override shares its master's UID and, having no RRULE of its own,
        // also falls into this non-recurring branch — key it by the ORIGINAL slot it replaces
        // (matching the master expansion's own skip-set below), not the bare UID, or two overrides
        // on the same series collide onto one externalId and lose one of them.
        const recurrenceId = event.isRecurrenceException() ? (event.recurrenceId as ICAL.Time | null) : null;
        const externalId = recurrenceId ? `${uid}#${recurrenceId.toJSDate().toISOString().slice(0, 10)}` : uid;
        shifts.push(this.buildShift(externalId, config.venueId, start, durationMs, assignments));
        continue;
      }

      const overrideDates = overrideDatesByUid.get(uid);
      const expand = new ICAL.RecurExpansion({ component: vevent, dtstart: vevent.getFirstPropertyValue('dtstart') as ICAL.Time });
      let next: ICAL.Time | null;
      // ical.js's own JSDoc for RecurExpansion says "next is always an ICAL.Time or null" and its
      // usage example iterates with this exact `while ((next = expand.next()))` shape — but the
      // bundled .d.ts types `next(): Time` (non-nullable), another case of the .d.ts disagreeing
      // with the library's own documented/actual runtime behavior. Cast to the real, nullable type.
      while ((next = expand.next() as ICAL.Time | null)) {
        const start = next.toJSDate();
        if (start.getTime() > toMs) break; // occurrences are in ascending order — nothing later can be in range either
        if (start.getTime() < fromMs) continue;
        const dateStr = start.toISOString().slice(0, 10);
        // M2: a RECURRENCE-ID override supersedes this slot — its own VEVENT (processed above,
        // non-recurring branch) already produced the authoritative shift for this date.
        if (overrideDates?.has(dateStr)) continue;
        const externalId = `${uid}#${dateStr}`;
        shifts.push(this.buildShift(externalId, config.venueId, start, durationMs, assignments));
      }
    }

    return { upserted: 0, errors, shifts };
  }

  private buildShift(
    externalId: string,
    venueId: string,
    start: Date,
    durationMs: number,
    assignments: { email?: string; role: Role }[],
  ): ExternalShift {
    const end = new Date(start.getTime() + durationMs);
    return {
      externalId,
      venueId,
      date: start.toISOString().slice(0, 10),
      startsAt: start.toISOString(),
      endsAt: end.toISOString(),
      assignments,
    };
  }

  /** Returns the assignment list for one VEVENT, plus any adapter-level errors (an unresolved
   * `matchBy: 'name'` lookup) to fold into the sync's own `errors` array. `byName` is non-null
   * exactly when `matchBy === 'name'` (see the call site's own ternary). */
  private resolveAssignments(
    vevent: ICAL.Component,
    summary: string,
    byName: Map<string, string> | null,
    role: Role,
  ): { assignments: { email?: string; role: Role }[]; assignmentErrors: string[] } {
    const attendeeProps = vevent.getAllProperties('attendee');

    if (byName) {
      if (attendeeProps.length > 0) {
        const assignments: { email?: string; role: Role }[] = [];
        const assignmentErrors: string[] = [];
        for (const p of attendeeProps) {
          const cn = (p.getParameter('cn') as string | null)?.trim();
          const email = cn ? byName.get(cn.toLowerCase()) : undefined;
          if (email) assignments.push({ email, role });
          else assignmentErrors.push(`unresolved name "${cn ?? '(no CN)'}"`);
        }
        return { assignments, assignmentErrors };
      }
      // No ATTENDEE at all — fall back to matching the whole SUMMARY text as a name.
      const email = byName.get(summary.trim().toLowerCase());
      if (email) return { assignments: [{ email, role }], assignmentErrors: [] };
      return { assignments: [], assignmentErrors: summary ? [`unresolved name "${summary}"`] : [] };
    }

    if (attendeeProps.length > 0) {
      return {
        assignments: attendeeProps.map((p) => ({ email: stripMailto(String(p.getFirstValue())), role })),
        assignmentErrors: [],
      };
    }
    const description = vevent.getFirstPropertyValue('description') as string | null;
    const m = description ? EMAIL_RE.exec(description) : null;
    if (m) return { assignments: [{ email: m[1]!.toLowerCase(), role }], assignmentErrors: [] };
    return { assignments: [], assignmentErrors: [] };
  }

  async healthCheck(ctx: ProviderContext): Promise<{ ok: boolean; message?: string }> {
    const config = readConfig(ctx.config);
    try {
      const res = await this.fetchCalendar(config.feedUrl);
      if (res.status !== 200) return { ok: false, message: `HTTP ${res.status}` };
      if (!res.text.includes('BEGIN:VCALENDAR')) return { ok: false, message: 'response is not a VCALENDAR' };
      return { ok: true };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }
}
