import { beforeEach, expect, it } from 'vitest';
import { copyFor, sendPushHandler } from './push.js';
import { NOW, OP, TID, V1, seedOperator, testDeps, ticketDoc, wipe } from '../../../test/helpers.js';
import { P } from '../../lib/paths.js';
import { ticketWrittenHandler } from '../tickets/ticket.handler.js';
beforeEach(async () => { await wipe(testDeps()); });
it('copy for statuses', () => { expect(copyFor('ticket.status', { status: 'ready' })).toEqual({ title: 'Your car is ready', body: 'Head to the valet stand.' }); expect(copyFor('ticket.status', { status: 'requested' }).title).toBe('Request received'); });
it('copy for incident.created: labels the type, names the venue, and includes the ref when present', () => {
  expect(copyFor('incident.created', { type: 'damage', venue: 'St. Elmo', ref: 'ABC123' })).toEqual({ title: 'Damage reported at St. Elmo', body: 'Ref: ABC123' });
  expect(copyFor('incident.created', { type: 'theft', venue: 'St. Elmo' })).toEqual({ title: 'Theft reported at St. Elmo', body: 'Tap to view details.' });
  expect(copyFor('incident.created', { type: 'unknown_future_type', venue: 'St. Elmo' }).title).toBe('Incident reported at St. Elmo');
});
it('all tokens invalid → failed and an SMS fallback is queued for the ticket', async () => {
  const deps = testDeps(); await seedOperator(deps); await deps.db.doc('guests/g1').set({ phoneE164: '+13175550123', fcmTokens: ['bad'] }); await deps.db.doc(P.ticket(OP, TID)).set(ticketDoc({ status: 'ready', guest: { uid: 'g1', phoneE164: '+13175550123', phoneLast4: '0123', consentSms: true } }));
  await deps.db.doc('pushEvents/p2').set({ id: 'p2', operatorId: OP, ticketId: TID, kind: 'ticket.status', data: { status: 'ready' }, toUid: 'g1', status: 'queued', createdAt: NOW });
  await sendPushHandler(deps, 'p2', { send: () => { const e = new Error('x') as Error & { code: string }; e.code = 'messaging/registration-token-not-registered'; return Promise.reject(e); } });
  // Ruling AM: deterministic id shared with ticket.handler.ts's enqueueSms (no `_fallback` suffix).
  expect((await deps.db.doc(P.outbound(`${TID}_ready`)).get()).exists).toBe(true);
});
it('sends to guest tokens and prunes invalid ones; every send carries data.kind for client routing', async () => {
  const deps = testDeps(); await seedOperator(deps); await deps.db.doc('guests/g1').set({ phoneE164: '+1', fcmTokens: ['good', 'bad'] });
  await deps.db.doc('pushEvents/p1').set({ id: 'p1', operatorId: OP, ticketId: TID, kind: 'ticket.status', data: { ticketId: TID, status: 'ready' }, toUid: 'g1', status: 'queued', createdAt: NOW });
  const sent: string[] = []; const payloads: Record<string, string>[] = [];
  await sendPushHandler(deps, 'p1', { send: (m) => { const token = 'token' in m ? m.token : undefined; sent.push(token!); payloads.push(m.data as Record<string, string>); if (token === 'bad') { const e = new Error('x') as Error & { code: string }; e.code = 'messaging/registration-token-not-registered'; return Promise.reject(e); } return Promise.resolve('id'); } });
  expect(sent).toEqual(['good', 'bad']); expect((await deps.db.doc('guests/g1').get()).data()?.fcmTokens).toEqual(['good']);
  // Mobile fix round: `kind` is what the device routes on — it was consumed server-side by copyFor
  // and never sent, leaving the client an untagged bag of ids. Every token send must carry it
  // ALONGSIDE the producer's own fields, none dropped.
  for (const p of payloads) expect(p).toEqual({ ticketId: TID, status: 'ready', kind: 'ticket.status' });
  const p1 = (await deps.db.doc('pushEvents/p1').get()).data(); expect(p1?.status).toBe('sent'); expect(p1?.delivered).toBe(1);
});
it('topic path sends once, marks sent, and carries data.kind for client routing', async () => {
  const deps = testDeps(); await seedOperator(deps);
  await deps.db.doc('pushEvents/p3').set({ id: 'p3', operatorId: OP, ticketId: TID, kind: 'venue.request', data: { venueId: V1 }, toTopic: `venue_${OP}_${V1}`, status: 'queued', createdAt: NOW });
  const calls: { topic?: string; data?: Record<string, string> }[] = [];
  await sendPushHandler(deps, 'p3', { send: (m) => { calls.push('topic' in m ? { topic: m.topic, data: m.data as Record<string, string> } : {}); return Promise.resolve('id'); } });
  expect(calls).toEqual([{ topic: `venue_${OP}_${V1}`, data: { venueId: V1, kind: 'venue.request' } }]);
  expect((await deps.db.doc('pushEvents/p3').get()).data()?.status).toBe('sent');
});
it('no tokens → skipped and an SMS fallback is queued', async () => {
  const deps = testDeps(); await seedOperator(deps); await deps.db.doc('guests/g1').set({ phoneE164: '+13175550123', fcmTokens: [] });
  await deps.db.doc(P.ticket(OP, TID)).set(ticketDoc({ status: 'ready', guest: { uid: 'g1', phoneE164: '+13175550123', phoneLast4: '0123', consentSms: true } }));
  await deps.db.doc('pushEvents/p4').set({ id: 'p4', operatorId: OP, ticketId: TID, kind: 'ticket.status', data: { status: 'ready' }, toUid: 'g1', status: 'queued', createdAt: NOW });
  await sendPushHandler(deps, 'p4', { send: () => Promise.resolve('id') });
  expect((await deps.db.doc('pushEvents/p4').get()).data()?.status).toBe('skipped');
  expect((await deps.db.doc(P.outbound(`${TID}_ready`)).get()).exists).toBe(true);
});
it('assigned fallback picks driveHomeAssigned for a drive_home ticket', async () => {
  const deps = testDeps(); await seedOperator(deps); await deps.db.doc('guests/g1').set({ phoneE164: '+13175550123', fcmTokens: [] });
  await deps.db.doc(P.ticket(OP, TID)).set(ticketDoc({ status: 'assigned', jobType: 'drive_home', guest: { uid: 'g1', phoneE164: '+13175550123', phoneLast4: '0123', consentSms: true } }));
  await deps.db.doc('pushEvents/p5').set({ id: 'p5', operatorId: OP, ticketId: TID, kind: 'ticket.status', data: { status: 'assigned' }, toUid: 'g1', status: 'queued', createdAt: NOW });
  await sendPushHandler(deps, 'p5', { send: () => Promise.resolve('id') });
  expect((await deps.db.doc(P.outbound(`${TID}_driveHomeAssigned`)).get()).exists).toBe(true);
});
it('assigned fallback picks rideAssigned for a passenger_ride ticket', async () => {
  const deps = testDeps(); await seedOperator(deps); await deps.db.doc('guests/g1').set({ phoneE164: '+13175550123', fcmTokens: [] });
  await deps.db.doc(P.ticket(OP, TID)).set(ticketDoc({ status: 'assigned', jobType: 'passenger_ride', guest: { uid: 'g1', phoneE164: '+13175550123', phoneLast4: '0123', consentSms: true } }));
  await deps.db.doc('pushEvents/p6').set({ id: 'p6', operatorId: OP, ticketId: TID, kind: 'ticket.status', data: { status: 'assigned' }, toUid: 'g1', status: 'queued', createdAt: NOW });
  await sendPushHandler(deps, 'p6', { send: () => Promise.resolve('id') });
  expect((await deps.db.doc(P.outbound(`${TID}_rideAssigned`)).get()).exists).toBe(true);
});
it('closed fallback queues the survey template', async () => {
  const deps = testDeps(); await seedOperator(deps); await deps.db.doc('guests/g1').set({ phoneE164: '+13175550123', fcmTokens: [] });
  await deps.db.doc(P.ticket(OP, TID)).set(ticketDoc({ status: 'closed', guest: { uid: 'g1', phoneE164: '+13175550123', phoneLast4: '0123', consentSms: true } }));
  await deps.db.doc('pushEvents/p7').set({ id: 'p7', operatorId: OP, ticketId: TID, kind: 'ticket.status', data: { status: 'closed' }, toUid: 'g1', status: 'queued', createdAt: NOW });
  await sendPushHandler(deps, 'p7', { send: () => Promise.resolve('id') });
  expect((await deps.db.doc(P.outbound(`${TID}_survey`)).get()).exists).toBe(true);
});
it('consentSms false → no fallback SMS is queued', async () => {
  const deps = testDeps(); await seedOperator(deps); await deps.db.doc('guests/g1').set({ phoneE164: '+13175550123', fcmTokens: [] });
  await deps.db.doc(P.ticket(OP, TID)).set(ticketDoc({ status: 'ready', guest: { uid: 'g1', phoneE164: '+13175550123', phoneLast4: '0123', consentSms: false } }));
  await deps.db.doc('pushEvents/p8').set({ id: 'p8', operatorId: OP, ticketId: TID, kind: 'ticket.status', data: { status: 'ready' }, toUid: 'g1', status: 'queued', createdAt: NOW });
  await sendPushHandler(deps, 'p8', { send: () => Promise.resolve('id') });
  expect((await deps.db.doc(P.outbound(`${TID}_ready`)).get()).exists).toBe(false);
});
// Ruling AN (1d final review, finding 7): a guest who disabled push but still has registered tokens
// must be skipped exactly like tokens-empty — pushed anyway would ignore an explicit opt-out.
it('consent.push:false with tokens present → skipped (never pushed) and an SMS fallback is queued (Ruling AN)', async () => {
  const deps = testDeps(); await seedOperator(deps);
  await deps.db.doc('guests/g1').set({ phoneE164: '+13175550123', fcmTokens: ['good'], consent: { push: false } });
  await deps.db.doc(P.ticket(OP, TID)).set(ticketDoc({ status: 'ready', guest: { uid: 'g1', phoneE164: '+13175550123', phoneLast4: '0123', consentSms: true } }));
  await deps.db.doc('pushEvents/p9').set({ id: 'p9', operatorId: OP, ticketId: TID, kind: 'ticket.status', data: { status: 'ready' }, toUid: 'g1', status: 'queued', createdAt: NOW });
  let sendCalled = false;
  await sendPushHandler(deps, 'p9', { send: () => { sendCalled = true; return Promise.resolve('id'); } });
  expect(sendCalled).toBe(false); // never attempted a push send despite having a valid token
  expect((await deps.db.doc('pushEvents/p9').get()).data()?.status).toBe('skipped');
  expect((await deps.db.doc(P.outbound(`${TID}_ready`)).get()).exists).toBe(true);
});
it('consent.push:true (or unset) with tokens present → pushed normally, no fallback', async () => {
  const deps = testDeps(); await seedOperator(deps);
  await deps.db.doc('guests/g1').set({ phoneE164: '+13175550123', fcmTokens: ['good'], consent: { push: true } });
  await deps.db.doc(P.ticket(OP, TID)).set(ticketDoc({ status: 'ready', guest: { uid: 'g1', phoneE164: '+13175550123', phoneLast4: '0123', consentSms: true } }));
  await deps.db.doc('pushEvents/p10').set({ id: 'p10', operatorId: OP, ticketId: TID, kind: 'ticket.status', data: { status: 'ready' }, toUid: 'g1', status: 'queued', createdAt: NOW });
  await sendPushHandler(deps, 'p10', { send: () => Promise.resolve('id') });
  expect((await deps.db.doc('pushEvents/p10').get()).data()?.status).toBe('sent');
  expect((await deps.db.doc(P.outbound(`${TID}_ready`)).get()).exists).toBe(false);
});
// Cross-module seam (1c ticket trigger × 1d push handler) — the exact race Ruling AM fixed: a guest
// with a uid but no working push token must get exactly ONE outbound SMS, never two, regardless of
// whether the trigger's direct SMS or the push handler's fallback runs/lands first.
it('exactly-once SMS for a uid guest with no push token — trigger SMS then push fallback collide into one doc (Ruling AM)', async () => {
  const deps = testDeps(); await seedOperator(deps);
  await deps.db.doc('guests/g1').set({ phoneE164: '+13175550123', fcmTokens: [] });
  const t = ticketDoc({ status: 'ready', guest: { uid: 'g1', phoneE164: '+13175550123', phoneLast4: '0123', consentSms: true } });
  await deps.db.doc(P.ticket(OP, TID)).set(t);
  // 1c's ticket-write trigger: guestHasPush(g1) is false (zero tokens) → queues the direct SMS AND a
  // pushEvent for the same status change.
  await ticketWrittenHandler(deps, { operatorId: OP, ticketId: TID, before: { ...t, status: 'checked_in' }, after: t });
  expect((await deps.db.doc(P.outbound(`${TID}_ready`)).get()).exists).toBe(true);
  // 1d's push handler now processes that pushEvent — finds no tokens, falls back to the SAME id.
  const pushEvents = await deps.db.collection('pushEvents').where('ticketId', '==', TID).get();
  for (const d of pushEvents.docs) await sendPushHandler(deps, d.id, { send: () => Promise.resolve('id') });
  const outbound = await deps.db.collection('outboundMessages').where('ticketId', '==', TID).where('template', '==', 'ready').get();
  expect(outbound.size).toBe(1);
});
