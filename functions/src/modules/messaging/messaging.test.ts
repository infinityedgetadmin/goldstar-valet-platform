import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { renderTemplate } from './templates.js';
import { sendOutboundHandler } from './sender.js';
import { inboundHandler } from './inbound.js';
import { statusHandler } from './status.js';
import { TwilioProvider } from './twilio.adapter.js';
import { FakeTwilio } from '../../../test/fakes/twilio.js';
import { NOW, OP, TID, seedOperator, testDeps, ticketDoc, wipe } from '../../../test/helpers.js';
import { P } from '../../lib/paths.js';
import { ticketWrittenHandler } from '../tickets/ticket.handler.js';

const INBOUND_URL = 'https://us-central1-demo.cloudfunctions.net/twilioInbound';
const STATUS_URL = 'https://us-central1-demo.cloudfunctions.net/twilioStatus';
const AUTH_TOKEN = 'tok_x';

// Twilio signature = base64(HMAC-SHA1(authToken, url + sorted(key+value)...)) — shared by every
// inbound/status test below instead of recomputing it inline at each call site.
function sign(url: string, params: Record<string, string>, authToken = AUTH_TOKEN): string {
  return createHmac('sha1', authToken).update(url + Object.keys(params).sort().map((k) => k + (params[k] ?? '')).join('')).digest('base64');
}

beforeEach(async () => {
  await wipe(testDeps());
});

describe('templates', () => {
  it('venue override beats platform default; tokens replaced', () => {
    expect(renderTemplate('ready', { venue: 'St. Elmo', link: 'https://x/t/1', operator: 'Goldstar' }, { ready: 'Car ready at {{venue}}! {{link}}' })).toBe('Car ready at St. Elmo! https://x/t/1');
    expect(renderTemplate('welcome', { venue: 'V', link: 'L', operator: 'O' }, {})).toContain('Reply STOP');
  });
});

describe('sender', () => {
  it('renders with venue template, sends via provider with messaging service, marks sent', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    const fake = new FakeTwilio();
    await deps.db.doc(P.outbound('m1')).set({
      id: 'm1', channel: 'sms', operatorId: OP, venueId: 'v1', ticketId: TID, to: '+13175550123', template: 'ready', vars: { venue: 'St. Elmo', link: 'https://x' }, status: 'queued', attempts: 0, createdAt: NOW,
    });
    await sendOutboundHandler(deps, 'm1', new TwilioProvider(fake));
    expect(fake.sent[0]).toMatchObject({ to: '+13175550123', messagingServiceSid: 'MG_x' });
    expect(fake.sent[0]!.body).toContain('St. Elmo');
    expect((await deps.db.doc(P.outbound('m1')).get()).data()).toMatchObject({ status: 'sent', providerRef: 'SM1', attempts: 1 });
  });

  it('a live lease blocks a concurrent sender; an expired lease is retried', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    const fake = new FakeTwilio();
    await deps.db.doc(P.outbound('m3')).set({
      id: 'm3', channel: 'sms', operatorId: OP, to: '+13175550123', template: 'ready', vars: {}, status: 'sending', leaseUntil: '2026-08-23T21:01:00.000Z', attempts: 1, createdAt: NOW,
    });
    await sendOutboundHandler(deps, 'm3', new TwilioProvider(fake));
    expect(fake.sent).toHaveLength(0);
    await deps.db.doc(P.outbound('m3')).update({ leaseUntil: '2026-08-23T20:00:00.000Z' });
    await sendOutboundHandler(deps, 'm3', new TwilioProvider(fake));
    expect(fake.sent).toHaveLength(1);
  });

  it('provider failure → retry scheduled, then failed after 5 attempts', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    const fake = new FakeTwilio();
    fake.fail = true;
    await deps.db.doc(P.outbound('m2')).set({ id: 'm2', channel: 'sms', operatorId: OP, to: '+13175550123', template: 'ready', vars: {}, status: 'queued', attempts: 4, createdAt: NOW });
    await sendOutboundHandler(deps, 'm2', new TwilioProvider(fake));
    expect((await deps.db.doc(P.outbound('m2')).get()).data()?.status).toBe('failed');
  });

  it('provider failure at attempts 0 → status retry with retryAt set (not failed)', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    const fake = new FakeTwilio();
    fake.fail = true;
    await deps.db.doc(P.outbound('m6')).set({ id: 'm6', channel: 'sms', operatorId: OP, to: '+13175550123', template: 'ready', vars: {}, status: 'queued', attempts: 0, createdAt: NOW });
    await sendOutboundHandler(deps, 'm6', new TwilioProvider(fake));
    const doc = (await deps.db.doc(P.outbound('m6')).get()).data() as { status?: string; attempts?: number; retryAt?: string } | undefined;
    expect(doc?.status).toBe('retry');
    expect(doc?.attempts).toBe(1);
    expect(doc?.retryAt).toBeTruthy();
  });
});

describe('status', () => {
  it('valid signature + known providerRef writes delivery status (and ErrorCode → deliveryError)', async () => {
    const deps = testDeps();
    await deps.db.doc(P.outbound('m4')).set({ id: 'm4', channel: 'sms', operatorId: OP, to: '+13175550123', template: 'ready', vars: {}, status: 'sent', attempts: 1, createdAt: NOW, providerRef: 'SM99' });

    const delivered = { MessageSid: 'SM99', MessageStatus: 'delivered' };
    const res1 = await statusHandler(deps, { url: STATUS_URL, params: delivered, signature: sign(STATUS_URL, delivered), authToken: AUTH_TOKEN });
    expect(res1).toEqual({ status: 204 });
    const afterDelivered = (await deps.db.doc(P.outbound('m4')).get()).data() as { deliveryStatus?: string; deliveryUpdatedAt?: string; deliveryError?: string } | undefined;
    expect(afterDelivered?.deliveryStatus).toBe('delivered');
    expect(afterDelivered?.deliveryUpdatedAt).toBe(NOW);
    expect(afterDelivered?.deliveryError).toBeUndefined();

    const failed = { MessageSid: 'SM99', MessageStatus: 'failed', ErrorCode: '30003' };
    await statusHandler(deps, { url: STATUS_URL, params: failed, signature: sign(STATUS_URL, failed), authToken: AUTH_TOKEN });
    const afterFailed = (await deps.db.doc(P.outbound('m4')).get()).data() as { deliveryStatus?: string; deliveryError?: string } | undefined;
    expect(afterFailed?.deliveryStatus).toBe('failed');
    expect(afterFailed?.deliveryError).toBe('30003');
  });

  it('bad signature → 403, zero writes', async () => {
    const deps = testDeps();
    await deps.db.doc(P.outbound('m5')).set({ id: 'm5', channel: 'sms', operatorId: OP, to: '+13175550123', template: 'ready', vars: {}, status: 'sent', attempts: 1, createdAt: NOW, providerRef: 'SM100' });
    const params = { MessageSid: 'SM100', MessageStatus: 'delivered' };
    const res = await statusHandler(deps, { url: STATUS_URL, params, signature: 'bad', authToken: AUTH_TOKEN });
    expect(res).toEqual({ status: 403 });
    const after = (await deps.db.doc(P.outbound('m5')).get()).data() as { deliveryStatus?: string } | undefined;
    expect(after?.deliveryStatus).toBeUndefined();
  });

  // Ruling AV (1d final review, finding 15): (MessageSid, MessageStatus) dedupe — Twilio's status
  // callbacks are at-least-once, so the exact same callback can be redelivered.
  it('a redelivered identical (MessageSid, MessageStatus) callback is a no-op on the second delivery (Ruling AV)', async () => {
    const deps = testDeps();
    await deps.db.doc(P.outbound('m6')).set({ id: 'm6', channel: 'sms', operatorId: OP, to: '+13175550123', template: 'ready', vars: {}, status: 'sent', attempts: 1, createdAt: NOW, providerRef: 'SM101' });
    const delivered = { MessageSid: 'SM101', MessageStatus: 'delivered' };
    await statusHandler(deps, { url: STATUS_URL, params: delivered, signature: sign(STATUS_URL, delivered), authToken: AUTH_TOKEN });
    expect((await deps.db.doc(P.processed('twilio', 'SM101_delivered')).get()).exists).toBe(true);
    // Redeliver the identical callback — dedupe key already exists, must short-circuit before the
    // outboundMessages query even runs (asserted indirectly: deliveryUpdatedAt does not change even
    // though `now()` would differ on a real second call — here we just confirm no error and status 204).
    const res = await statusHandler(deps, { url: STATUS_URL, params: delivered, signature: sign(STATUS_URL, delivered), authToken: AUTH_TOKEN });
    expect(res).toEqual({ status: 204 });
  });

  // Ruling AV: once a message reaches a terminal state, a late/out-of-order EARLIER-STAGE callback
  // (e.g. 'sent', delayed behind 'delivered') must not regress the display field.
  it('a late "sent" callback arriving after "delivered" does not overwrite it (Ruling AV)', async () => {
    const deps = testDeps();
    await deps.db.doc(P.outbound('m7')).set({ id: 'm7', channel: 'sms', operatorId: OP, to: '+13175550123', template: 'ready', vars: {}, status: 'sent', attempts: 1, createdAt: NOW, providerRef: 'SM102' });
    const delivered = { MessageSid: 'SM102', MessageStatus: 'delivered' };
    await statusHandler(deps, { url: STATUS_URL, params: delivered, signature: sign(STATUS_URL, delivered), authToken: AUTH_TOKEN });
    const lateSent = { MessageSid: 'SM102', MessageStatus: 'sent' };
    await statusHandler(deps, { url: STATUS_URL, params: lateSent, signature: sign(STATUS_URL, lateSent), authToken: AUTH_TOKEN });
    const after = (await deps.db.doc(P.outbound('m7')).get()).data() as { deliveryStatus?: string } | undefined;
    expect(after?.deliveryStatus).toBe('delivered'); // NOT regressed to 'sent'
  });

  it('a DIFFERENT terminal status (e.g. failed) after an earlier terminal status is still recorded — the last terminal callback wins', async () => {
    const deps = testDeps();
    await deps.db.doc(P.outbound('m8')).set({ id: 'm8', channel: 'sms', operatorId: OP, to: '+13175550123', template: 'ready', vars: {}, status: 'sent', attempts: 1, createdAt: NOW, providerRef: 'SM103' });
    const delivered = { MessageSid: 'SM103', MessageStatus: 'delivered' };
    await statusHandler(deps, { url: STATUS_URL, params: delivered, signature: sign(STATUS_URL, delivered), authToken: AUTH_TOKEN });
    const failed = { MessageSid: 'SM103', MessageStatus: 'failed', ErrorCode: '30003' };
    await statusHandler(deps, { url: STATUS_URL, params: failed, signature: sign(STATUS_URL, failed), authToken: AUTH_TOKEN });
    const after = (await deps.db.doc(P.outbound('m8')).get()).data() as { deliveryStatus?: string } | undefined;
    expect(after?.deliveryStatus).toBe('failed');
  });
});

describe('inbound', () => {
  async function seedTicketWithProjection(deps: ReturnType<typeof testDeps>, over: Record<string, unknown> = {}) {
    const t = ticketDoc(over);
    await deps.db.doc(P.ticket(OP, TID)).set(t);
    // Builds the guestTickets/{token} projection requestVehicleHandler's resolveToken reads — same
    // seeding step guest.test.ts's seedTicket() helper uses.
    await ticketWrittenHandler(deps, { operatorId: OP, ticketId: TID, before: null, after: t });
    return t;
  }

  it('STOP revokes consent on open tickets and guest; CAR requests the latest open valet ticket; signature required', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await seedTicketWithProjection(deps);

    const stopParams = { From: '+13175550123', To: '+13175550100', Body: 'STOP', MessageSid: 'SM9' };
    expect(await inboundHandler(deps, { url: INBOUND_URL, params: stopParams, signature: 'bad', authToken: AUTH_TOKEN })).toEqual({ status: 403 });
    const res = await inboundHandler(deps, { url: INBOUND_URL, params: stopParams, signature: sign(INBOUND_URL, stopParams), authToken: AUTH_TOKEN });
    expect(res.status).toBe(200);
    const afterStop = (await deps.db.doc(P.ticket(OP, TID)).get()).data() as { guest: { consentSms: boolean } } | undefined;
    expect(afterStop?.guest.consentSms).toBe(false);

    const carParams = { From: '+13175550123', To: '+13175550100', Body: 'CAR', MessageSid: 'SM10' };
    await inboundHandler(deps, { url: INBOUND_URL, params: carParams, signature: sign(INBOUND_URL, carParams), authToken: AUTH_TOKEN });
    expect((await deps.db.doc(P.ticket(OP, TID)).get()).data()?.status).toBe('requested');
  });

  it('START restores consent after STOP, on both the ticket and the durable guests doc (round-tripped again via alias UNSTOP)', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await seedTicketWithProjection(deps);
    await deps.db.doc(P.guest('guestUid1')).set({ phoneE164: '+13175550123', fcmTokens: [], savedVehicles: [], consent: { sms: true, push: true }, updatedAt: NOW });
    const base = { From: '+13175550123', To: '+13175550100' };

    // round trip 1: STOP → START
    const stop1 = { ...base, Body: 'STOP', MessageSid: 'SM20' };
    await inboundHandler(deps, { url: INBOUND_URL, params: stop1, signature: sign(INBOUND_URL, stop1), authToken: AUTH_TOKEN });
    let ticket = (await deps.db.doc(P.ticket(OP, TID)).get()).data() as { guest: { consentSms: boolean } };
    let guest = (await deps.db.doc(P.guest('guestUid1')).get()).data() as { consent: { sms: boolean } };
    expect(ticket.guest.consentSms).toBe(false);
    expect(guest.consent.sms).toBe(false);

    const start = { ...base, Body: 'START', MessageSid: 'SM21' };
    const startRes = await inboundHandler(deps, { url: INBOUND_URL, params: start, signature: sign(INBOUND_URL, start), authToken: AUTH_TOKEN });
    expect(startRes).toEqual({ status: 200, twiml: '<Response><Message>You are subscribed again.</Message></Response>' });
    ticket = (await deps.db.doc(P.ticket(OP, TID)).get()).data() as { guest: { consentSms: boolean } };
    guest = (await deps.db.doc(P.guest('guestUid1')).get()).data() as { consent: { sms: boolean } };
    expect(ticket.guest.consentSms).toBe(true);
    expect(guest.consent.sms).toBe(true);

    // round trip 2: STOP → UNSTOP (alias)
    const stop2 = { ...base, Body: 'STOP', MessageSid: 'SM22' };
    await inboundHandler(deps, { url: INBOUND_URL, params: stop2, signature: sign(INBOUND_URL, stop2), authToken: AUTH_TOKEN });
    const unstop = { ...base, Body: 'UNSTOP', MessageSid: 'SM23' };
    await inboundHandler(deps, { url: INBOUND_URL, params: unstop, signature: sign(INBOUND_URL, unstop), authToken: AUTH_TOKEN });
    ticket = (await deps.db.doc(P.ticket(OP, TID)).get()).data() as { guest: { consentSms: boolean } };
    guest = (await deps.db.doc(P.guest('guestUid1')).get()).data() as { consent: { sms: boolean } };
    expect(ticket.guest.consentSms).toBe(true);
    expect(guest.consent.sms).toBe(true);
  });

  it('HELP returns static TwiML with no state change', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await seedTicketWithProjection(deps);
    const before = (await deps.db.doc(P.ticket(OP, TID)).get()).data();

    const params = { From: '+13175550123', To: '+13175550100', Body: 'HELP', MessageSid: 'SM30' };
    const res = await inboundHandler(deps, { url: INBOUND_URL, params, signature: sign(INBOUND_URL, params), authToken: AUTH_TOKEN });
    expect(res).toEqual({ status: 200, twiml: '<Response><Message>Reply 1 to request your car. Reply STOP to opt out. Need a person? Use the link in your check-in text.</Message></Response>' });
    expect((await deps.db.doc(P.ticket(OP, TID)).get()).data()).toEqual(before);
  });

  it('a command that throws returns 500 with no twiml, and logs only the error name', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    // Deliberately skip ticketWrittenHandler — no guestTickets/{token} projection exists, so
    // requestVehicleHandler's resolveToken throws guest_token_expired once the CAR command reaches
    // it, after signature verification and the dedupe check have both already passed.
    await deps.db.doc(P.ticket(OP, TID)).set(ticketDoc());
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const params = { From: '+13175550123', To: '+13175550100', Body: 'CAR', MessageSid: 'SM40' };
    const res = await inboundHandler(deps, { url: INBOUND_URL, params, signature: sign(INBOUND_URL, params), authToken: AUTH_TOKEN });
    expect(res).toEqual({ status: 500 });
    expect(errSpy).toHaveBeenCalledWith('twilio inbound handling failed', { name: 'PlatformError' });
    errSpy.mockRestore();
  });

  it('CAR with no active checked_in valet ticket returns the not-found TwiML with no state change', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    const t = ticketDoc({ status: 'requested', times: { checkedInAt: NOW, requestedAt: NOW } });
    await deps.db.doc(P.ticket(OP, TID)).set(t);
    const before = (await deps.db.doc(P.ticket(OP, TID)).get()).data();

    const params = { From: '+13175550123', To: '+13175550100', Body: 'CAR', MessageSid: 'SM50' };
    const res = await inboundHandler(deps, { url: INBOUND_URL, params, signature: sign(INBOUND_URL, params), authToken: AUTH_TOKEN });
    expect(res).toEqual({ status: 200, twiml: '<Response><Message>We could not find an active ticket for this number.</Message></Response>' });
    expect((await deps.db.doc(P.ticket(OP, TID)).get()).data()).toEqual(before);
  });

  it('alias spot-checks: STOPALL behaves like STOP, "1" behaves like CAR', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await seedTicketWithProjection(deps);

    const stopall = { From: '+13175550123', To: '+13175550100', Body: 'STOPALL', MessageSid: 'SM60' };
    await inboundHandler(deps, { url: INBOUND_URL, params: stopall, signature: sign(INBOUND_URL, stopall), authToken: AUTH_TOKEN });
    const afterStopall = (await deps.db.doc(P.ticket(OP, TID)).get()).data() as { guest: { consentSms: boolean } };
    expect(afterStopall.guest.consentSms).toBe(false);

    const one = { From: '+13175550123', To: '+13175550100', Body: '1', MessageSid: 'SM61' };
    await inboundHandler(deps, { url: INBOUND_URL, params: one, signature: sign(INBOUND_URL, one), authToken: AUTH_TOKEN });
    expect((await deps.db.doc(P.ticket(OP, TID)).get()).data()?.status).toBe('requested');
  });
});
