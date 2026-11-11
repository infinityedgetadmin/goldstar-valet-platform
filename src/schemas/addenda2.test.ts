import { describe, expect, it } from 'vitest';
import { auditLogEntrySchema } from './auditLogEntry';
import { outboundMessageSchema } from './outboundMessage';
import { invitationSchema } from './invitation';
import { integrationSchema } from './integration';
import { platformConfigSchema } from './platformConfig';
import { metricsDailySchema } from './metricsDaily';
import { metricsForecastSchema } from './metricsForecast';
import { shiftSchema } from './shift';
import { operatorSchema } from './operator';
import { credentialsSchema } from './user';

const ID = '01912345-7abc-7def-8123-456789abcdef';
const now = '2026-08-23T21:00:00.000Z';

describe('auditLogEntrySchema', () => {
  const base = { id: 'al1', actorUid: 'u1', action: 'ticket.cancel', target: `tickets/${ID}`, before: { status: 'requested' }, after: { status: 'cancelled' }, at: now, requestId: 'req-1' };
  it('parses a full entry, including operatorId and a system actor', () => {
    expect(auditLogEntrySchema.safeParse({ ...base, operatorId: 'goldstar', actorUid: 'system', ip: '127.0.0.1' }).success).toBe(true);
  });
  it('parses without the optional operatorId/ip', () => {
    expect(auditLogEntrySchema.safeParse(base).success).toBe(true);
  });
  it('accepts null before/after', () => {
    expect(auditLogEntrySchema.safeParse({ ...base, before: null, after: null }).success).toBe(true);
  });
  it('rejects a missing requestId', () => {
    const { id, actorUid, action, target, before, after, at } = base;
    expect(auditLogEntrySchema.safeParse({ id, actorUid, action, target, before, after, at }).success).toBe(false);
  });
  it('rejects an empty action', () => {
    expect(auditLogEntrySchema.safeParse({ ...base, action: '' }).success).toBe(false);
  });
});

describe('outboundMessageSchema', () => {
  const base = { id: 'om1', channel: 'sms', operatorId: 'goldstar', to: '+13175550123', template: 'ready', vars: { name: 'Ana' }, status: 'queued', attempts: 0, createdAt: now };
  it('parses a full message with all optional fields', () => {
    expect(outboundMessageSchema.safeParse({ ...base, venueId: 'v1', ticketId: ID, providerRef: 'SM123', lastError: 'timeout', leaseUntil: now, retryAt: now, deliveryStatus: 'delivered', sentAt: now }).success).toBe(true);
  });
  it('parses the minimal shape', () => {
    expect(outboundMessageSchema.safeParse(base).success).toBe(true);
  });
  it('rejects an unrecognized status', () => {
    expect(outboundMessageSchema.safeParse({ ...base, status: 'bounced' }).success).toBe(false);
  });
  it('rejects a non-uuid ticketId', () => {
    expect(outboundMessageSchema.safeParse({ ...base, ticketId: 'not-a-uuid' }).success).toBe(false);
  });
});

describe('invitationSchema', () => {
  const base = { id: 'inv1', email: 'a@b.example.com', operatorId: 'goldstar', roles: ['attendant'], venueIds: ['v1'], displayName: null, tokenHash: 'a'.repeat(64), expiresAt: now, acceptedAt: null, invitedBy: 'u1', createdAt: now };
  it('parses a pending invitation with a nullable displayName/acceptedAt', () => {
    expect(invitationSchema.safeParse(base).success).toBe(true);
  });
  it('parses an accepted invitation', () => {
    expect(invitationSchema.safeParse({ ...base, displayName: 'Ana', acceptedAt: now, acceptedUid: 'u2' }).success).toBe(true);
  });
  it('rejects a tokenHash of the wrong length', () => {
    expect(invitationSchema.safeParse({ ...base, tokenHash: 'a'.repeat(63) }).success).toBe(false);
  });
  it('rejects an unknown role', () => {
    expect(invitationSchema.safeParse({ ...base, roles: ['king'] }).success).toBe(false);
  });
});

describe('integrationSchema', () => {
  it('defaults status and config', () => {
    const parsed = integrationSchema.parse({ provider: 'twilio' });
    expect(parsed.status).toBe('configured');
    expect(parsed.config).toEqual({});
  });
  it('parses a full record with health', () => {
    expect(integrationSchema.safeParse({ provider: 'stripe', status: 'active', config: { platformFeeBps: 250 }, secretRef: 'secrets/stripe', lastSyncAt: now, health: { ok: false, errors: ['auth_failed'] } }).success).toBe(true);
  });
  it('rejects an unrecognized status', () => {
    expect(integrationSchema.safeParse({ provider: 'stripe', status: 'bogus' }).success).toBe(false);
  });
});

describe('platformConfigSchema', () => {
  it('applies documented defaults when parsing an empty object', () => {
    const parsed = platformConfigSchema.parse({});
    expect(parsed).toEqual({ tipPresets: [18, 20, 25], laborRateDefault: 1800, targetRequestsPerAttendantHour: 6, rideEndorsements: [] });
  });
  it('accepts overrides', () => {
    expect(platformConfigSchema.safeParse({ tipPresets: [15, 20], laborRateDefault: 2000, targetRequestsPerAttendantHour: 8, rideEndorsements: ['wheelchair'] }).success).toBe(true);
  });
  it('rejects a fractional tip preset', () => {
    expect(platformConfigSchema.safeParse({ tipPresets: [18.5] }).success).toBe(false);
  });
});

describe('metricsDailySchema', () => {
  const venueMetric = {
    tickets: 10, retrievalP50: 300, retrievalP90: 600, throughputPerAttendantHour: 4,
    tips: 5000, avgTip: 500, tipRate: 0.2, revenue: 15000, damageReports: 1, claims: 0, laborCostPerVehicle: 800, laborCostTotal: 8000, platformFees: 150, refundedTotal: 0,
    hourly: Array.from({ length: 24 }, () => 0),
    driveHome: { jobs: 2, completionSec: 900, chaseUtilization: 0.5 }, rides: { jobs: 1 },
    // Plan 4b Task 7: added to `venueMetricsSchema` alongside the other 15 `METRIC_DEFINITIONS`
    // keys, plus `laborCostTotal`/`platformFees` for the executive P&L — this fixture is updated
    // in place rather than left stale, so this pre-existing suite keeps asserting against the
    // CURRENT (v0.3.7) required shape instead of silently going green on a shape the schema no
    // longer accepts.
    credentialCompliance: 90, offlineSyncSuccess: 98,
  };
  it('parses venues + operator rollups sharing the same per-venue shape', () => {
    expect(metricsDailySchema.safeParse({ venues: { v1: venueMetric }, operator: venueMetric, day: '2026-08-23', updatedAt: now }).success).toBe(true);
  });
  it('accepts null retrieval percentiles when there is no data', () => {
    const noData = { ...venueMetric, retrievalP50: null, retrievalP90: null, avgTip: null, tipRate: null, laborCostPerVehicle: null, credentialCompliance: null, offlineSyncSuccess: null };
    expect(metricsDailySchema.safeParse({ venues: { v1: noData }, operator: noData, day: '2026-08-23', updatedAt: now }).success).toBe(true);
  });
  it('rejects an hourly array that is not exactly 24 entries', () => {
    const bad = { ...venueMetric, hourly: [0, 1, 2] };
    expect(metricsDailySchema.safeParse({ venues: { v1: bad }, operator: venueMetric, day: '2026-08-23', updatedAt: now }).success).toBe(false);
  });
  it('rejects a credentialCompliance percentage outside 0-100', () => {
    expect(metricsDailySchema.safeParse({ venues: { v1: { ...venueMetric, credentialCompliance: 101 } }, operator: venueMetric, day: '2026-08-23', updatedAt: now }).success).toBe(false);
  });
});

describe('metricsForecastSchema', () => {
  // Row-of-objects (not `number[7][24]`) — Firestore rejects a field that's an array directly
  // containing another array ("Cannot convert an array value in an array value", hit for real
  // against the emulator writing this doc — see `metricsForecast.ts`'s own header comment).
  const grid = Array.from({ length: 7 }, (_, weekday) => ({ weekday, hours: Array.from({ length: 24 }, () => 0) }));
  const staffingGrid = Array.from({ length: 7 }, (_, weekday) => ({ weekday, hours: Array.from({ length: 24 }, () => 0) }));
  it('parses a full 7x24 forecast grid per venue', () => {
    expect(metricsForecastSchema.safeParse({ venues: { v1: { byWeekdayHour: grid, suggestedAttendants: staffingGrid } }, isoWeek: '2026-W35', weeksAveraged: 4, updatedAt: now }).success).toBe(true);
  });
  it('rejects a malformed isoWeek string', () => {
    expect(metricsForecastSchema.safeParse({ venues: {}, isoWeek: '2026-35', weeksAveraged: 0, updatedAt: now }).success).toBe(false);
  });
  it('rejects a grid with fewer than 7 weekday rows', () => {
    const shortGrid = grid.slice(0, 6);
    expect(metricsForecastSchema.safeParse({ venues: { v1: { byWeekdayHour: shortGrid, suggestedAttendants: staffingGrid } }, isoWeek: '2026-W35', weeksAveraged: 4, updatedAt: now }).success).toBe(false);
  });
  it('rejects a negative suggestedAttendants value', () => {
    const badStaffing = staffingGrid.map((row, i) => (i === 0 ? { ...row, hours: [-1, ...row.hours.slice(1)] } : row));
    expect(metricsForecastSchema.safeParse({ venues: { v1: { byWeekdayHour: grid, suggestedAttendants: badStaffing } }, isoWeek: '2026-W35', weeksAveraged: 4, updatedAt: now }).success).toBe(false);
  });
  it('rejects rows that are out of weekday order', () => {
    const shuffled = [grid[1]!, grid[0]!, ...grid.slice(2)];
    expect(metricsForecastSchema.safeParse({ venues: { v1: { byWeekdayHour: shuffled, suggestedAttendants: staffingGrid } }, isoWeek: '2026-W35', weeksAveraged: 4, updatedAt: now }).success).toBe(false);
  });
});

describe('shift tipPool', () => {
  const base = { id: 's1', operatorId: 'goldstar', venueId: 'v1', date: '2026-08-23', startsAt: now, endsAt: now, status: 'closed' as const, assignments: [], source: { provider: 'internal' as const } };
  it('is optional and accepts a full pool', () => {
    expect(shiftSchema.safeParse(base).success).toBe(true);
    expect(shiftSchema.safeParse({ ...base, tipPool: { total: 10000, hoursByUid: { u1: 6 }, allocations: [{ uid: 'u1', amount: 10000 }] } }).success).toBe(true);
  });
  it('rejects a negative pool total', () => {
    expect(shiftSchema.safeParse({ ...base, tipPool: { total: -1, hoursByUid: {}, allocations: [] } }).success).toBe(false);
  });
});

describe('operator security', () => {
  const base = {
    id: 'goldstar', name: 'Goldstar', slug: 'goldstar', status: 'active' as const, timezone: 'America/Indiana/Indianapolis', currency: 'USD', isSandbox: false, plan: 'standard',
    branding: { displayName: 'Goldstar', primaryColor: '#ab6034', accentColor: '#ffc30c' },
    modules: { payments: { provider: 'stripe' as const, chargeModel: 'destination' as const, platformFeeBps: 0, tipPresets: [20], tipPolicy: 'deliverer' as const }, messaging: { provider: 'twilio' as const }, scheduling: { provider: 'internal' as const }, vision: { provider: 'none' as const }, accounting: { provider: 'csv' as const } },
    features: { driveHome: true, passengerRides: true, venuePortals: true, tapToPay: false, plateOcr: false, payouts: true },
    createdAt: now, updatedAt: now, createdBy: 'system',
  };
  it('defaults requireMfaForAdmins to false', () => {
    expect(operatorSchema.parse(base).security).toEqual({ requireMfaForAdmins: false });
  });
  it('accepts an explicit true', () => {
    expect(operatorSchema.parse({ ...base, security: { requireMfaForAdmins: true } }).security).toEqual({ requireMfaForAdmins: true });
  });
});

describe('credentials medicalCard', () => {
  it('is optional and parses an expiry', () => {
    expect(credentialsSchema.safeParse({}).success).toBe(true);
    expect(credentialsSchema.safeParse({ medicalCard: { expiresAt: now } }).success).toBe(true);
  });
  it('rejects a malformed expiresAt', () => {
    expect(credentialsSchema.safeParse({ medicalCard: { expiresAt: 'not-a-date' } }).success).toBe(false);
  });
});
