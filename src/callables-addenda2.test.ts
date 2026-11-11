import { describe, expect, it } from 'vitest';
import { callables, type CallableInput } from './callables';

const ID = '01912345-7abc-7def-8123-456789abcdef';

describe('CallableInput is the pre-parse shape', () => {
  it('a ticketsSearch input without limit/includeArchived type-checks and parses with defaults applied', () => {
    const raw = { from: '2026-08-01T00:00:00.000Z', to: '2026-08-23T00:00:00.000Z' } satisfies CallableInput<'ticketsSearch'>;
    const parsed = callables.ticketsSearch.input.parse(raw);
    expect(parsed.limit).toBe(50);
    expect(parsed.includeArchived).toBe(false);
  });
});

describe('typed callable outputs', () => {
  const ticket = {
    id: ID, operatorId: 'goldstar', venueId: 'v1', jobType: 'valet', status: 'checked_in', source: 'staff',
    guest: { phoneE164: '+13175550123', phoneLast4: '0123', consentSms: true }, vehicle: {},
    flags: { assistance: false, accessibleVehicle: false, photosSkipped: false, vip: false },
    attendants: {}, times: { checkedInAt: '2026-08-23T21:00:00.000Z' }, guestToken: 'AbCdEfGhIjKlMnOpQrStUv', damageReportIds: [], incidentIds: [],
  };
  it('ticketsSearch output validates each ticket against ticketSchema', () => {
    expect(callables.ticketsSearch.output.safeParse({ tickets: [ticket] }).success).toBe(true);
    expect(callables.ticketsSearch.output.safeParse({ tickets: [{ ...ticket, status: 'en_route_to_pickup' }] }).success).toBe(false);
  });
  const transaction = { id: 'tx1', operatorId: 'goldstar', venueId: 'v1', ticketId: ID, provider: 'stripe', providerRef: 'pi_1', kind: 'charge', status: 'succeeded', base: 1500, tip: 300, tax: 105, fees: 0, total: 1905, currency: 'USD', method: 'web', at: '2026-08-23T21:00:00.000Z' };
  it('paymentsSearch output validates each transaction against transactionSchema', () => {
    expect(callables.paymentsSearch.output.safeParse({ transactions: [transaction] }).success).toBe(true);
    expect(callables.paymentsSearch.output.safeParse({ transactions: [{ ...transaction, provider: 'paypal' }] }).success).toBe(false);
  });
  const entry = { id: 'al1', actorUid: 'u1', action: 'ticket.cancel', target: `tickets/${ID}`, before: null, after: null, at: '2026-08-23T21:00:00.000Z', requestId: 'req-1' };
  it('auditQuery output validates each entry against auditLogEntrySchema', () => {
    expect(callables.auditQuery.output.safeParse({ entries: [entry] }).success).toBe(true);
    expect(callables.auditQuery.output.safeParse({ entries: [{ ...entry, requestId: undefined }] }).success).toBe(false);
  });
  it('guestRequestVehicle output requires a real ticket status', () => {
    expect(callables.guestRequestVehicle.output.safeParse({ status: 'requested' }).success).toBe(true);
    expect(callables.guestRequestVehicle.output.safeParse({ status: 'bogus' }).success).toBe(false);
  });
  const venueMetric = {
    tickets: 10, retrievalP50: 300, retrievalP90: 600, throughputPerAttendantHour: 4,
    tips: 5000, avgTip: 500, tipRate: 20, revenue: 15000, damageReports: 1, claims: 0, laborCostPerVehicle: 800, laborCostTotal: 8000, platformFees: 150, refundedTotal: 0,
    driveHome: { jobs: 2, completionSec: 900, chaseUtilization: 50 }, rides: { jobs: 1 },
    credentialCompliance: 90, offlineSyncSuccess: 98,
  };
  it('analyticsSummary output validates the venue-metrics-minus-hourly shape, and rejects a raw hourly field leaking through', () => {
    // `days` (carry #44) is REQUIRED, not optional — so a construction that forgets it fails here
    // rather than reaching a consumer as a silently absent field. Its entries are full
    // `venueMetricsSchema` values, hourly included, which is what `venueMetricsSummary` omits.
    const day = { day: '2026-08-01', metrics: { ...venueMetric, hourly: Array.from({ length: 24 }, () => 0) } };
    const out = { from: '2026-08-01', to: '2026-08-23', operator: venueMetric, venues: { v1: venueMetric }, previousPeriod: { from: '2026-07-09', to: '2026-07-31', operator: venueMetric, venues: { v1: venueMetric } }, days: [day] };
    expect(callables.analyticsSummary.output.safeParse(out).success).toBe(true);
    // The omission is per-FIELD, not global: the summary buckets drop hourly, the per-day series
    // keeps it. A change that omitted it from both would pass the assertion below but break the
    // heatmap, so pin the positive side too.
    expect(callables.analyticsSummary.output.parse(out).days[0]!.metrics.hourly).toHaveLength(24);
    expect(callables.analyticsSummary.output.safeParse({ ...out, days: undefined }).success).toBe(false);
    // `.omit({hourly:true})` strips the key on parse rather than rejecting its presence (zod's
    // default `.object()` behavior) — asserting the PARSED result has no `hourly` key is the
    // correct way to pin that omission down, not a `.safeParse(...).success` check (which would
    // stay `true` either way and prove nothing).
    expect(callables.analyticsSummary.output.parse(out).operator).not.toHaveProperty('hourly');
  });
  it('analyticsSummary input requires day-string (not full ISO timestamp) range bounds', () => {
    expect(callables.analyticsSummary.input.safeParse({ from: '2026-08-01', to: '2026-08-23' }).success).toBe(true);
    expect(callables.analyticsSummary.input.safeParse({ from: '2026-08-01T00:00:00.000Z', to: '2026-08-23' }).success).toBe(false);
  });
});

describe('tightened callable inputs', () => {
  it('identityInvite.roles only accepts invitable staff/venue roles', () => {
    expect(callables.identityInvite.input.safeParse({ email: 'a@b.example.com', roles: ['owner', 'venue_user'] }).success).toBe(true);
    expect(callables.identityInvite.input.safeParse({ email: 'a@b.example.com', roles: ['guest'] }).success).toBe(false);
    expect(callables.identityInvite.input.safeParse({ email: 'a@b.example.com', roles: ['platform_admin'] }).success).toBe(false);
  });
  it('ticketsSearch.status only accepts a real ticket status', () => {
    const base = { from: '2026-08-01T00:00:00.000Z', to: '2026-08-23T00:00:00.000Z' };
    expect(callables.ticketsSearch.input.safeParse({ ...base, status: 'claimed' }).success).toBe(true);
    expect(callables.ticketsSearch.input.safeParse({ ...base, status: 'bogus' }).success).toBe(false);
  });
  it('paymentsSearch.status only accepts a transaction status', () => {
    const base = { from: '2026-08-01T00:00:00.000Z', to: '2026-08-23T00:00:00.000Z' };
    expect(callables.paymentsSearch.input.safeParse({ ...base, status: 'succeeded' }).success).toBe(true);
    expect(callables.paymentsSearch.input.safeParse({ ...base, status: 'paid' }).success).toBe(false);
  });
  it('venueHostRequest.phoneE164 requires E.164', () => {
    const base = { venueId: 'v1', kind: 'car' as const };
    expect(callables.venueHostRequest.input.safeParse({ ...base, phoneE164: '+13175550123' }).success).toBe(true);
    expect(callables.venueHostRequest.input.safeParse({ ...base, phoneE164: '317-555-0123' }).success).toBe(false);
  });
  it('integrationsSetSecret/HealthCheck.provider only accepts a known manifest id', () => {
    expect(callables.integrationsSetSecret.input.safeParse({ provider: 'stripe', name: 'apiKey', value: 'sk_live' }).success).toBe(true);
    expect(callables.integrationsSetSecret.input.safeParse({ provider: 'square', name: 'apiKey', value: 'sk_live' }).success).toBe(false);
    expect(callables.integrationsHealthCheck.input.safeParse({ provider: 'twilio' }).success).toBe(true);
    expect(callables.integrationsHealthCheck.input.safeParse({ provider: 'square' }).success).toBe(false);
  });
});
