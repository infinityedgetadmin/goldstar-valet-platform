import { beforeEach, describe, expect, it } from 'vitest';
import { renderEmail, ResendProvider, sendEmailHandler } from './email.js';
import { PermanentSendError } from './errors.js';
import { sendOutboundHandler } from './sender.js';
import { inviteHandler } from '../identity/invite.js';
import { FakeResend } from '../../../test/fakes/resend.js';
import { NOW, OP, seedOperator, testDeps, wipe } from '../../../test/helpers.js';
import { P } from '../../lib/paths.js';

beforeEach(async () => {
  await wipe(testDeps());
});

describe('renderEmail', () => {
  it('invitation: subject + HTML contain the accept URL and the verified staff-app deep link', () => {
    const { subject, html } = renderEmail('invitation', {
      token: 'tok_abc123',
      operatorName: 'Goldstar',
      inviteeName: 'Jordan Lee',
      acceptUrl: 'https://app.goldstar.example.com/accept-invite?token=tok_abc123',
    });
    expect(subject).toContain('Goldstar');
    expect(html).toContain('https://app.goldstar.example.com/accept-invite?token=tok_abc123');
    expect(html).toContain('Jordan Lee');
    // Verified real production staff-app scheme, re-derived from goldstar-mobile (see invitation.ts).
    expect(html).toContain('goldstarvaletstaff://accept-invite?token=tok_abc123');
  });

  it('invitation: falls back to a generic greeting when inviteeName is omitted — matches real invite.ts, which does not queue one today', () => {
    const { html } = renderEmail('invitation', { token: 't1', operatorName: 'Goldstar', acceptUrl: 'https://x/accept-invite?token=t1' });
    expect(html).toContain('Hello,');
  });

  it('invitation: escapes HTML in operator/invitee-supplied strings (no markup injection)', () => {
    const { html } = renderEmail('invitation', {
      token: 't1',
      operatorName: '<script>evil()</script>',
      inviteeName: '<img src=x onerror=evil()>',
      acceptUrl: 'https://x/accept-invite?token=t1',
    });
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;');
  });

  it('credentialExpiring: renders with displayName/field/days (dispatch key matches eligibility.ts\'s real producer, not the credential-expiry.ts filename)', () => {
    const { subject, html } = renderEmail('credentialExpiring', {
      operatorName: 'Goldstar',
      displayName: 'Sam Attendant',
      field: 'license',
      days: 7,
      expiresAt: '2026-09-01T00:00:00.000Z',
    });
    expect(subject).toContain('7 days');
    expect(html).toContain('Sam Attendant');
    expect(html).toContain("driver's license");
  });

  it('claimUpdate: renders status copy, guest name, and a formatted settlement amount', () => {
    const { subject, html } = renderEmail('claimUpdate', {
      operatorName: 'Goldstar',
      guestName: 'Taylor Guest',
      claimId: 'clm_1',
      status: 'settled',
      amountCents: 25_000,
      currency: 'USD',
    });
    expect(subject).toContain('settled');
    expect(html).toContain('$250.00');
    expect(html).toContain('Taylor Guest');
  });

  it('invoice: renders line items and formatted totals', () => {
    const { subject, html } = renderEmail('invoice', {
      operatorName: 'Goldstar',
      venueName: 'St. Elmo',
      invoiceId: 'inv_1',
      period: '2026-08',
      lines: [{ label: 'Valet tickets', quantity: 120, unitAmount: 1500, amount: 180_000 }],
      subtotal: 180_000,
      tax: 12_600,
      total: 192_600,
      currency: 'USD',
    });
    expect(subject).toContain('August 2026');
    expect(html).toContain('St. Elmo');
    expect(html).toContain('$1,926.00');
  });

  it('receipt: renders venue/date/line items and a formatted total, with a CTA when receiptUrl is present', () => {
    const { subject, html } = renderEmail('receipt', {
      operatorName: 'Goldstar',
      venueName: 'St. Elmo',
      ticketRef: '01912345',
      paidAt: '2026-08-23T21:00:00.000Z',
      base: 1500,
      tip: 300,
      tax: 105,
      fees: 0,
      total: 1905,
      currency: 'USD',
      receiptUrl: 'https://app.goldstar.example.com/t/tok123#receipt',
    });
    expect(subject).toContain('St. Elmo');
    expect(html).toContain('St. Elmo');
    expect(html).toContain('$19.05');
    expect(html).toContain('01912345');
    expect(html).toContain('View Full Receipt');
    expect(html).toContain('https://app.goldstar.example.com/t/tok123#receipt');
  });

  // The literals below are DELIBERATE — do not "deduplicate" them into CHARGE_LABELS imports.
  // The template renders from @goldstar/platform's shared CHARGE_LABELS (Ruling AN), so pinning
  // the raw strings here is what makes this a contract test of that constant's values: an edit to
  // the shared map fails HERE instead of silently propagating to every consumer.
  it('receipt: the base line is labeled by jobType — "Valet" / "Drive home" / "Ride", exactly those strings — and absent jobType stays "Valet" (queued-doc compatibility)', () => {
    const vars = {
      operatorName: 'Goldstar',
      venueName: 'St. Elmo',
      ticketRef: '01912345',
      paidAt: '2026-08-23T21:00:00.000Z',
      base: 2500,
      tip: 0,
      tax: 175,
      fees: 0,
      total: 2675,
      currency: 'USD',
    };
    expect(renderEmail('receipt', { ...vars, jobType: 'drive_home' }).html).toContain('Drive home');
    expect(renderEmail('receipt', { ...vars, jobType: 'drive_home' }).html).not.toContain('>Valet<');
    expect(renderEmail('receipt', { ...vars, jobType: 'passenger_ride' }).html).toContain('Ride');
    expect(renderEmail('receipt', { ...vars, jobType: 'valet' }).html).toContain('Valet');
    expect(renderEmail('receipt', vars).html).toContain('Valet');
  });

  it('receipt: omits the fees row when fees is 0, and omits the CTA when receiptUrl is absent', () => {
    const { html } = renderEmail('receipt', {
      operatorName: 'Goldstar',
      venueName: 'St. Elmo',
      ticketRef: '01912345',
      paidAt: '2026-08-23T21:00:00.000Z',
      base: 1500,
      tip: 300,
      tax: 105,
      fees: 0,
      total: 1905,
      currency: 'USD',
    });
    expect(html).not.toContain('Fees');
    expect(html).not.toContain('View Full Receipt');
  });

  it('receipt: distinct dispatch key from the SMS-only "receipt" template (templates.ts) — an invalid currency fails schema validation, not a render-time RangeError', () => {
    expect(() =>
      renderEmail('receipt', {
        operatorName: 'Goldstar',
        venueName: 'St. Elmo',
        ticketRef: '01912345',
        paidAt: '2026-08-23T21:00:00.000Z',
        base: 1500,
        tip: 300,
        tax: 105,
        fees: 0,
        total: 1905,
        currency: 'usd',
      }),
    ).toThrow(PermanentSendError);
  });

  it('receipt: rejects a non-https receiptUrl, e.g. a javascript: scheme (Minor-2)', () => {
    expect(() =>
      renderEmail('receipt', {
        operatorName: 'Goldstar',
        venueName: 'St. Elmo',
        ticketRef: '01912345',
        paidAt: '2026-08-23T21:00:00.000Z',
        base: 1500,
        tip: 300,
        tax: 105,
        fees: 0,
        total: 1905,
        currency: 'USD',
        receiptUrl: 'javascript:alert(1)',
      }),
    ).toThrow(PermanentSendError);
  });

  it('throws PermanentSendError for an unknown template name (Finding M3 — not a transient-retry-eligible error)', () => {
    expect(() => renderEmail('does-not-exist', {})).toThrow(/unknown email template/);
    expect(() => renderEmail('does-not-exist', {})).toThrow(PermanentSendError);
  });

  it('throws PermanentSendError (schema validation) when required vars are missing', () => {
    expect(() => renderEmail('invitation', { token: 't1' })).toThrow(PermanentSendError);
  });

  it('claimUpdate: an invalid currency code fails schema validation, not a render-time RangeError (Finding M2)', () => {
    // Before M2's fix, `z.string().length(3)` accepted 'usd' — Intl.NumberFormat then threw a
    // RangeError inside formatMoney at render time instead of failing cleanly at .parse().
    expect(() =>
      renderEmail('claimUpdate', { operatorName: 'Goldstar', claimId: 'clm_1', status: 'settled', amountCents: 100, currency: 'usd' }),
    ).toThrow(PermanentSendError);
  });

  it('invoice: an invalid currency code fails schema validation, not a render-time RangeError (Finding M2)', () => {
    expect(() =>
      renderEmail('invoice', {
        operatorName: 'Goldstar',
        venueName: 'St. Elmo',
        invoiceId: 'inv_1',
        period: '2026-08',
        lines: [{ label: 'x', quantity: 1, unitAmount: 100, amount: 100 }],
        subtotal: 100,
        tax: 0,
        total: 100,
        currency: '123',
      }),
    ).toThrow(PermanentSendError);
  });

  it('credentialExpiring: a non-ISO expiresAt fails schema validation instead of silently rendering "Invalid Date" (Minor-1)', () => {
    expect(() =>
      renderEmail('credentialExpiring', { operatorName: 'Goldstar', displayName: 'Sam', field: 'license', days: 3, expiresAt: 'not-a-date' }),
    ).toThrow(PermanentSendError);
  });

  it('invitation: rejects a non-https acceptUrl, e.g. a javascript: scheme (Minor-2)', () => {
    expect(() => renderEmail('invitation', { token: 't1', operatorName: 'Goldstar', acceptUrl: 'javascript:alert(1)' })).toThrow(PermanentSendError);
  });

  it('claimUpdate/invoice: reject a non-https portalUrl (Minor-2)', () => {
    expect(() =>
      renderEmail('claimUpdate', { operatorName: 'Goldstar', claimId: 'clm_1', status: 'settled', portalUrl: 'javascript:alert(1)' }),
    ).toThrow(PermanentSendError);
    expect(() =>
      renderEmail('invoice', {
        operatorName: 'Goldstar',
        venueName: 'St. Elmo',
        invoiceId: 'inv_1',
        period: '2026-08',
        lines: [{ label: 'x', quantity: 1, unitAmount: 100, amount: 100 }],
        subtotal: 100,
        tax: 0,
        total: 100,
        currency: 'USD',
        portalUrl: 'javascript:alert(1)',
      }),
    ).toThrow(PermanentSendError);
  });
});

describe('sendEmailHandler', () => {
  it('posts {from,to,subject,html} to a ResendLike fake and returns providerRef', async () => {
    const fake = new FakeResend();
    const { providerRef } = await sendEmailHandler(
      testDeps(),
      { to: 'g@x.example.com', template: 'invitation', vars: { token: 't1', acceptUrl: 'https://d/accept-invite?token=t1' } },
      'Goldstar',
      new ResendProvider(fake),
    );
    expect(providerRef).toBe('re_1');
    expect(fake.sent[0]).toMatchObject({ to: 'g@x.example.com', from: 'Goldstar Valet <noreply@goldstar-mgmt.example.com>' });
    expect(fake.sent[0]!.subject as string).toContain('Goldstar');
    expect(fake.sent[0]!.html as string).toContain('accept-invite?token=t1');
  });
});

describe('ResendProvider — error classification (m3, final whole-branch review)', () => {
  it.each([
    ['validation_error', 422],
    ['invalid_from_address', 403],
    ['missing_required_field', 422],
    ['invalid_attachment', 422],
    ['invalid_api_key', 401],
  ])('a deterministic 4xx error (%s) throws PermanentSendError, not a plain Error', async (name, statusCode) => {
    const fake = new FakeResend();
    fake.fail = true;
    fake.failError = { message: `resend rejected: ${name}`, name, statusCode };
    await expect(new ResendProvider(fake).send({ to: 'x@x.example.com', subject: 's', html: 'h', from: 'f' })).rejects.toBeInstanceOf(PermanentSendError);
  });

  it.each([
    ['rate_limit_exceeded', 429],
    ['monthly_quota_exceeded', 429],
    ['concurrent_idempotent_requests', 409],
    ['security_error', 451],
    ['internal_server_error', 500],
  ])('an ambiguous/retryable error (%s) stays a plain Error, still eligible for the backoff cycle', async (name, statusCode) => {
    const fake = new FakeResend();
    fake.fail = true;
    fake.failError = { message: `resend: ${name}`, name, statusCode };
    const rejection = new ResendProvider(fake).send({ to: 'x@x.example.com', subject: 's', html: 'h', from: 'f' });
    await expect(rejection).rejects.toThrow(`resend: ${name}`);
    await expect(rejection).rejects.not.toBeInstanceOf(PermanentSendError);
  });

  it('an error with no `name` field (older/unstructured failure shape) stays a plain Error', async () => {
    const fake = new FakeResend();
    fake.fail = true; // default failError has no `name` — see fakes/resend.ts
    await expect(new ResendProvider(fake).send({ to: 'x@x.example.com', subject: 's', html: 'h', from: 'f' })).rejects.not.toBeInstanceOf(PermanentSendError);
  });
});

describe('sender (email channel)', () => {
  it('sends via provider and marks the outbound doc sent with providerRef', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    const fake = new FakeResend();
    await deps.db.doc(P.outbound('e1')).set({
      id: 'e1', channel: 'email', operatorId: OP, to: 'new@x.example.com', template: 'invitation', vars: { token: 'tok_x' }, status: 'queued', attempts: 0, createdAt: NOW,
    });
    await sendOutboundHandler(deps, 'e1', undefined, new ResendProvider(fake));
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]).toMatchObject({ to: 'new@x.example.com', from: 'Goldstar Valet <noreply@goldstar-mgmt.example.com>' });
    expect(fake.sent[0]!.html as string).toContain('accept-invite?token=tok_x');
    expect((await deps.db.doc(P.outbound('e1')).get()).data()).toMatchObject({ status: 'sent', providerRef: 're_1', attempts: 1 });
  });

  it('derives acceptUrl from the DASHBOARD_HOST fallback when the queued vars only have token — matches real invite.ts today', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    const fake = new FakeResend();
    await deps.db.doc(P.outbound('e2')).set({ id: 'e2', channel: 'email', operatorId: OP, to: 'new2@x.example.com', template: 'invitation', vars: { token: 'tok_y' }, status: 'queued', attempts: 0, createdAt: NOW });
    await sendOutboundHandler(deps, 'e2', undefined, new ResendProvider(fake));
    expect(fake.sent[0]!.html as string).toContain('https://app.goldstar.example.com/accept-invite?token=tok_y');
  });

  it('credentialExpiring outbound doc renders and sends', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    const fake = new FakeResend();
    await deps.db.doc(P.outbound('e3')).set({
      id: 'e3',
      channel: 'email',
      operatorId: OP,
      to: 'admin@x.example.com',
      template: 'credentialExpiring',
      vars: { displayName: 'Sam', field: 'insurance', days: 1, expiresAt: '2026-08-30T00:00:00.000Z' },
      status: 'queued',
      attempts: 0,
      createdAt: NOW,
    });
    await sendOutboundHandler(deps, 'e3', undefined, new ResendProvider(fake));
    expect(fake.sent[0]!.subject as string).toContain('1 day');
    expect((await deps.db.doc(P.outbound('e3')).get()).data()).toMatchObject({ status: 'sent' });
  });

  it('provider failure → retry scheduled, then failed after 5 attempts (same backoff sendOutboundHandler already applies to SMS)', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    const fake = new FakeResend();
    fake.fail = true;
    await deps.db.doc(P.outbound('e4')).set({ id: 'e4', channel: 'email', operatorId: OP, to: 'x@x.example.com', template: 'invitation', vars: { token: 't' }, status: 'queued', attempts: 4, createdAt: NOW });
    await sendOutboundHandler(deps, 'e4', undefined, new ResendProvider(fake));
    const doc = (await deps.db.doc(P.outbound('e4')).get()).data() as { status?: string; attempts?: number; lastError?: string } | undefined;
    expect(doc?.status).toBe('failed');
    expect(doc?.attempts).toBe(5);
    expect(doc?.lastError).toBe('resend down');
  });

  it('provider failure at attempts 0 → status retry with retryAt set (not failed)', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    const fake = new FakeResend();
    fake.fail = true;
    await deps.db.doc(P.outbound('e5')).set({ id: 'e5', channel: 'email', operatorId: OP, to: 'x@x.example.com', template: 'invitation', vars: { token: 't' }, status: 'queued', attempts: 0, createdAt: NOW });
    await sendOutboundHandler(deps, 'e5', undefined, new ResendProvider(fake));
    const doc = (await deps.db.doc(P.outbound('e5')).get()).data() as { status?: string; attempts?: number; retryAt?: string } | undefined;
    expect(doc?.status).toBe('retry');
    expect(doc?.attempts).toBe(1);
    expect(doc?.retryAt).toBeTruthy();
  });

  it('m3 (final whole-branch review): a deterministic Resend rejection (invalid_from_address) fails the outbound doc IMMEDIATELY — one provider call, no 5-attempt retry burn', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    const fake = new FakeResend();
    fake.fail = true;
    fake.failError = { message: 'From address is not verified', name: 'invalid_from_address', statusCode: 403 };
    await deps.db.doc(P.outbound('e4b')).set({ id: 'e4b', channel: 'email', operatorId: OP, to: 'x@x.example.com', template: 'invitation', vars: { token: 't' }, status: 'queued', attempts: 0, createdAt: NOW });
    await sendOutboundHandler(deps, 'e4b', undefined, new ResendProvider(fake));
    const doc = (await deps.db.doc(P.outbound('e4b')).get()).data() as { status?: string; attempts?: number; lastError?: string } | undefined;
    expect(doc?.status).toBe('failed');
    expect(doc?.attempts).toBe(1); // not 5 — the whole point of classifying it permanent
    expect(doc?.lastError).toBe('From address is not verified');
  });

  it('an unknown template on the outbound doc fails IMMEDIATELY (PermanentSendError, no retry burn — Finding M3), zero provider calls', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    const fake = new FakeResend();
    await deps.db.doc(P.outbound('e6')).set({ id: 'e6', channel: 'email', operatorId: OP, to: 'x@x.example.com', template: 'does-not-exist', vars: {}, status: 'queued', attempts: 0, createdAt: NOW });
    await sendOutboundHandler(deps, 'e6', undefined, new ResendProvider(fake));
    expect(fake.sent).toHaveLength(0);
    const doc = (await deps.db.doc(P.outbound('e6')).get()).data() as { status?: string; attempts?: number; lastError?: string } | undefined;
    expect(doc?.status).toBe('failed');
    expect(doc?.attempts).toBe(1);
    expect(doc?.lastError).toContain('unknown email template');
  });

  it('schema-invalid vars on the outbound doc also fail IMMEDIATELY (PermanentSendError — Finding M3), zero provider calls', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    const fake = new FakeResend();
    // 'invitation' with no `token` at all: buildEmailVars only derives acceptUrl when vars.token is a
    // string, so this doc reaches invitationEmailVarsSchema.parse() missing both required fields.
    await deps.db.doc(P.outbound('e7')).set({ id: 'e7', channel: 'email', operatorId: OP, to: 'x@x.example.com', template: 'invitation', vars: {}, status: 'queued', attempts: 0, createdAt: NOW });
    await sendOutboundHandler(deps, 'e7', undefined, new ResendProvider(fake));
    expect(fake.sent).toHaveLength(0);
    const doc = (await deps.db.doc(P.outbound('e7')).get()).data() as { status?: string; attempts?: number; lastError?: string } | undefined;
    expect(doc?.status).toBe('failed');
    expect(doc?.attempts).toBe(1);
    expect(doc?.lastError).toContain("invalid vars for email template 'invitation'");
  });

  it('M1: a real inviteHandler invite with displayName produces an outbound doc whose rendered email greets by name; without displayName, greeting falls back unchanged', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    const fakeNamed = new FakeResend();
    await inviteHandler(deps, { uid: 'adm1', operatorId: OP, roles: ['admin'], venueIds: [] }, { email: 'named@x.example.com', roles: ['attendant'], venueIds: [], displayName: 'Riley Staff' });
    const namedDoc = (await deps.db.collection('outboundMessages').where('to', '==', 'named@x.example.com').get()).docs[0]!;
    await sendOutboundHandler(deps, namedDoc.id, undefined, new ResendProvider(fakeNamed));
    expect(fakeNamed.sent[0]!.html as string).toContain('Hi Riley Staff,');

    const fakeAnon = new FakeResend();
    await inviteHandler(deps, { uid: 'adm1', operatorId: OP, roles: ['admin'], venueIds: [] }, { email: 'anon@x.example.com', roles: ['attendant'], venueIds: [] });
    const anonDoc = (await deps.db.collection('outboundMessages').where('to', '==', 'anon@x.example.com').get()).docs[0]!;
    await sendOutboundHandler(deps, anonDoc.id, undefined, new ResendProvider(fakeAnon));
    expect(fakeAnon.sent[0]!.html as string).toContain('Hello,');
    expect(fakeAnon.sent[0]!.html as string).not.toContain('Hi ,');
  });
});
