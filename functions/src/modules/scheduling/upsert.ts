import { createHash } from 'node:crypto';
import type { Deps } from '../../lib/deps.js';
import { P } from '../../lib/paths.js';
import type { ExternalShift, SyncResult } from './port.js';

export async function upsertExternalShifts(deps: Deps, operatorId: string, provider: string, shifts: ExternalShift[]): Promise<SyncResult> {
  const users = await deps.db.collection(`operators/${operatorId}/users`).get(); const byEmail = new Map<string, string>(); const byExt = new Map<string, string>();
  for (const u of users.docs) { const d = u.data() as { email?: string; externalIds?: Record<string, string> }; if (d.email) byEmail.set(d.email.toLowerCase(), u.id); const ext = d.externalIds?.[provider]; if (ext) byExt.set(ext, u.id); }
  let upserted = 0; const errors: string[] = [];
  for (const s of shifts) {
    const assignments: { uid: string; role: string; startsAt: string; endsAt: string; confirmed: boolean }[] = [];
    for (const a of s.assignments) { const uid = (a.externalUserId && byExt.get(a.externalUserId)) || (a.email && byEmail.get(a.email.toLowerCase())); if (!uid) { errors.push(`unmatched user ${a.email ?? a.externalUserId ?? '?'}`); continue; } assignments.push({ uid, role: a.role, startsAt: s.startsAt, endsAt: s.endsAt, confirmed: false }); }
    // assignedUids denormalizes assignments[].uid onto the shift doc (1b's shiftSchema; rules' shifts.list
    // and the myShifts query both array-contains it). It's part of `payload` — not appended after the hash
    // is computed — so a pure reassignment (same times, different staff) still bumps the hash and re-upserts.
    const payload = { venueId: s.venueId, date: s.date, startsAt: s.startsAt, endsAt: s.endsAt, assignments, assignedUids: assignments.map((a) => a.uid), notes: s.notes ?? '', ...(s.leadEmail && byEmail.get(s.leadEmail.toLowerCase()) ? { leadUid: byEmail.get(s.leadEmail.toLowerCase()) } : {}) };
    const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex'); const id = `${provider}_${s.externalId}`; const ref = deps.db.doc(P.shift(operatorId, id));
    const existing = (await ref.get()).data() as { source?: { hash?: string }; status?: string } | undefined;
    if (existing?.source?.hash === hash) continue;
    await ref.set({ id, operatorId, ...payload, status: existing?.status ?? 'planned', source: { provider, externalId: s.externalId, syncedAt: deps.now(), hash } }, { merge: true }); upserted++;
  }
  return { upserted, errors, shifts };
}
