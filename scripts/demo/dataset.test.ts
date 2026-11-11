import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { ROLES } from '../../src/domain/roles';
import { DRIVE_HOME_STATUSES, RIDE_STATUSES, VALET_STATUSES } from '../../src/domain/status';
import { MIN_PRE_DRIVE_PHOTOS } from '../../src/index';
import { auditLogEntrySchema } from '../../src/schemas/auditLogEntry';
import { claimSchema } from '../../src/schemas/claim';
import { damageReportSchema, photoSchema } from '../../src/schemas/damage';
import { fleetVehicleSchema } from '../../src/schemas/fleetVehicle';
import { guestSchema } from '../../src/schemas/guest';
import { hostRequestSchema } from '../../src/schemas/hostRequest';
import { incidentSchema } from '../../src/schemas/incident';
import { integrationSchema } from '../../src/schemas/integration';
import { invitationSchema } from '../../src/schemas/invitation';
import { invoiceSchema } from '../../src/schemas/invoice';
import { keyTagSchema } from '../../src/schemas/keyTag';
import { liveLocationSchema } from '../../src/schemas/liveLocation';
import { metricsDailySchema } from '../../src/schemas/metricsDaily';
import { metricsForecastSchema } from '../../src/schemas/metricsForecast';
import { operatorSchema } from '../../src/schemas/operator';
import { payoutAllocationSchema, payoutBatchSchema } from '../../src/schemas/payoutBatch';
import { clockEventSchema, shiftSchema } from '../../src/schemas/shift';
import { custodyEventSchema, ticketSchema } from '../../src/schemas/ticket';
import { transactionSchema } from '../../src/schemas/transaction';
import { userSchema } from '../../src/schemas/user';
import { validationSchema } from '../../src/schemas/validation';
import { venueSchema } from '../../src/schemas/venue';
import { BASE_WALKUP_VEHICLE, GUEST_PHONE, GUEST_UID, OP, SHIFTS } from './constants';
import { demoClock } from './context';
import { buildDemoDataset, orderForWrite, WRITE_ORDER } from './dataset';
import { isoWeek, METRICS_DAYS } from './metrics';
import { DEMO_PHOTOS } from './photos';
import type { SeedDoc, SeedDocKind } from './types';

const NOW = new Date('2026-10-24T22:30:00.000Z');
const dataset = buildDemoDataset(NOW);

const SCHEMAS: Record<SeedDocKind, z.ZodTypeAny> = {
  operator: operatorSchema,
  venue: venueSchema,
  user: userSchema,
  ticket: ticketSchema,
  custodyEvent: custodyEventSchema,
  keyTag: keyTagSchema,
  damageReport: damageReportSchema,
  photo: photoSchema,
  transaction: transactionSchema,
  liveLocation: liveLocationSchema,
  shift: shiftSchema,
  clockEvent: clockEventSchema,
  fleetVehicle: fleetVehicleSchema,
  incident: incidentSchema,
  claim: claimSchema,
  validation: validationSchema,
  hostRequest: hostRequestSchema,
  invoice: invoiceSchema,
  payoutBatch: payoutBatchSchema,
  payoutAllocation: payoutAllocationSchema,
  integration: integrationSchema,
  auditLogEntry: auditLogEntrySchema,
  invitation: invitationSchema,
  guest: guestSchema,
  metricsDaily: metricsDailySchema,
  metricsForecast: metricsForecastSchema,
};

function ofKind<K extends SeedDocKind>(kind: K): Extract<SeedDoc, { kind: K }>[] {
  return dataset.docs.filter((d): d is Extract<SeedDoc, { kind: K }> => d.kind === kind);
}

const values = <T>(items: T[]): Set<T> => new Set(items);

describe('demo dataset: every document matches its @goldstar/platform schema', () => {
  it.each(Object.keys(SCHEMAS) as SeedDocKind[])('%s documents parse', (kind) => {
    const docs = ofKind(kind);
    expect(docs.length, `no ${kind} documents in the dataset`).toBeGreaterThan(0);
    const failures = docs.flatMap((d) => {
      const r = SCHEMAS[kind].safeParse(d.data);
      return r.success ? [] : [`${d.path}: ${r.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`];
    });
    expect(failures).toEqual([]);
  });

  it('has unique document paths', () => {
    const paths = dataset.docs.map((d) => d.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('is deterministic for a given instant (re-running the seed overwrites, never duplicates)', () => {
    expect(buildDemoDataset(NOW)).toEqual(dataset);
  });
});

describe('demo dataset: every state the apps can show is represented', () => {
  const tickets = ofKind('ticket').map((d) => d.data);
  const byJob = (jobType: string): Set<string> => values(tickets.filter((t) => t.jobType === jobType).map((t) => t.status));

  it('covers every valet status', () => {
    expect([...byJob('valet')].sort()).toEqual([...VALET_STATUSES].sort());
  });

  it("covers every drive-home status (the base seed's job supplies 'assigned')", () => {
    expect([...byJob('drive_home'), 'assigned'].sort()).toEqual([...new Set([...DRIVE_HOME_STATUSES])].sort());
  });

  it('covers every passenger-ride status', () => {
    expect([...byJob('passenger_ride')].sort()).toEqual([...RIDE_STATUSES].sort());
  });

  it('covers every payment status and method', () => {
    const payments = tickets.flatMap((t) => (t.payment ? [t.payment] : []));
    expect([...values(payments.map((p) => p.status))].sort()).toEqual(['authorized', 'failed', 'none', 'paid', 'pending', 'refunded', 'room_charged', 'venue_billed']);
    expect([...values(payments.flatMap((p) => (p.method ? [p.method] : [])))].sort()).toEqual(['in_app', 'invoice', 'pms', 'reader', 'tap_to_pay', 'web']);
  });

  it('covers every claim, incident, invoice, payout, fleet, host-request and integration state', () => {
    expect([...values(ofKind('claim').map((d) => d.data.status))].sort()).toEqual(['accepted', 'denied', 'intake', 'settled', 'under_review']);
    expect([...values(ofKind('incident').map((d) => d.data.status))].sort()).toEqual(['open', 'resolved', 'reviewing']);
    expect([...values(ofKind('invoice').map((d) => d.data.status))].sort()).toEqual(['draft', 'paid', 'sent', 'void']);
    expect([...values(ofKind('payoutBatch').map((d) => d.data.status))].sort()).toEqual(['completed', 'failed', 'partial', 'pending']);
    expect([...values(ofKind('payoutAllocation').map((d) => d.data.status))].sort()).toEqual(['failed', 'paid', 'pending']);
    expect([...values(ofKind('fleetVehicle').map((d) => d.data.status))].sort()).toEqual(['available', 'in_use', 'maintenance', 'retired']);
    expect([...values(ofKind('hostRequest').map((d) => d.data.kind))].sort()).toEqual(['car', 'pre_arrival', 'ride']);
    expect([...values(ofKind('hostRequest').map((d) => d.data.status))].sort()).toEqual(['dismissed', 'matched', 'open', 'unmatched']);
    expect([...values(ofKind('validation').map((d) => d.data.type))].sort()).toEqual(['comp', 'full', 'partial', 'rate']);
    expect([...values(ofKind('integration').map((d) => d.data.status))].sort()).toEqual(['active', 'configured', 'disabled', 'error']);
    expect([...values(ofKind('shift').map((d) => d.data.status))].sort()).toEqual(['closed', 'open', 'planned']);
    expect([...values(ofKind('clockEvent').map((d) => d.data.type))].sort()).toEqual(['break_end', 'break_start', 'in', 'out']);
  });

  it('covers every operator status for the platform console', () => {
    expect([...values(ofKind('operator').map((d) => d.data.status))].sort()).toEqual(['active', 'onboarding', 'suspended']);
  });

  it('has a persona for every role, including the phone guest', () => {
    const staffRoles = ofKind('user').flatMap((d) => d.data.roles);
    const guestRoles = dataset.authUsers.flatMap((u) => (Array.isArray(u.claims?.roles) ? (u.claims.roles as string[]) : []));
    // platform_admin is the base seed's platform1 (re-written here), so it appears in the user docs.
    expect([...values([...staffRoles, ...guestRoles])].sort()).toEqual([...ROLES].sort());
    expect([...values(ofKind('user').map((d) => d.data.status))].sort()).toEqual(['active', 'invited', 'suspended']);
  });

  it("links the phone guest's tickets to the guest so the guest app lists them", () => {
    const guestTickets = tickets.filter((t) => t.guest.uid === GUEST_UID);
    expect(guestTickets.every((t) => t.guest.phoneE164 === GUEST_PHONE)).toBe(true);
    expect(values(guestTickets.map((t) => t.status))).toEqual(new Set(['checked_in', 'closed', 'quoted']));
    expect(dataset.authUsers.find((u) => u.uid === GUEST_UID)?.phoneNumber).toBe(GUEST_PHONE);
  });
});

describe('demo dataset: vehicles look like a real lot', () => {
  // Guests' own cars (valet and drive-home tickets carry a plate); a passenger ride's vehicle is a
  // company fleet car, which is not what this is about.
  const openWithCars = ofKind('ticket')
    .map((d) => d.data)
    .filter((t) => !['closed', 'cancelled'].includes(t.status) && t.vehicle.plate !== undefined);

  // The builder cycles a 16-car list across ~60 tickets. Without this the valet queue showed the
  // same "White Maserati Ghibli · MSR220" twice, and a guest's request looked like a duplicate.
  it('never shows the same plate on two open tickets', () => {
    const plates = openWithCars.map((t) => t.vehicle.plate);
    expect(new Set(plates).size).toBe(plates.length);
  });

  it("completes the base seed's bare walk-up Ford with a car no demo ticket uses", () => {
    // The base seed names only the make (all the Maestro flow needs), so the queue showed "Ford · A".
    expect(BASE_WALKUP_VEHICLE.make).toBe('Ford');
    for (const field of [BASE_WALKUP_VEHICLE.model, BASE_WALKUP_VEHICLE.color, BASE_WALKUP_VEHICLE.plate]) expect(field).not.toBe('');
    expect(openWithCars.map((t) => t.vehicle.plate)).not.toContain(BASE_WALKUP_VEHICLE.plate);
    const looks = openWithCars.map((t) => `${t.vehicle.color} ${t.vehicle.make} ${t.vehicle.model}`);
    expect(looks).not.toContain(`${BASE_WALKUP_VEHICLE.color} ${BASE_WALKUP_VEHICLE.make} ${BASE_WALKUP_VEHICLE.model}`);
  });

  it('never shows two identical-looking cars (color, make and model) on open tickets', () => {
    const looks = openWithCars.map((t) => `${t.vehicle.color} ${t.vehicle.make} ${t.vehicle.model}`);
    expect(new Set(looks).size).toBe(looks.length);
  });
});

describe('demo dataset: references resolve', () => {
  const ticketIds = new Set(ofKind('ticket').map((d) => d.data.id));
  const reportIds = new Set(ofKind('damageReport').map((d) => d.data.id));
  const keyTagIds = new Set(ofKind('keyTag').map((d) => d.data.id));

  it('custody events, transactions, reports, incidents and claims point at demo tickets', () => {
    const dangling = [
      ...ofKind('custodyEvent').filter((d) => !ticketIds.has(d.path.split('/')[3] ?? '')).map((d) => d.path),
      ...ofKind('transaction').filter((d) => !ticketIds.has(d.data.ticketId)).map((d) => d.path),
      ...ofKind('damageReport').filter((d) => !ticketIds.has(d.data.ticketId)).map((d) => d.path),
      ...ofKind('incident').filter((d) => d.data.ticketId !== undefined && !ticketIds.has(d.data.ticketId)).map((d) => d.path),
      ...ofKind('claim').filter((d) => !ticketIds.has(d.data.ticketId)).map((d) => d.path),
    ];
    expect(dangling).toEqual([]);
  });

  it("tickets' key tags, damage reports and custody pointers exist", () => {
    const custodyIds = new Set(ofKind('custodyEvent').map((d) => d.data.id));
    const bad = ofKind('ticket').filter(
      ({ data: t }) =>
        (t.keyTagId !== undefined && !keyTagIds.has(t.keyTagId)) ||
        t.damageReportIds.some((id) => !reportIds.has(id)) ||
        (t.lastCustodyEventId !== undefined && !custodyIds.has(t.lastCustodyEventId)),
    );
    expect(bad.map((d) => d.path)).toEqual([]);
    // Key tags point back at the ticket that holds them.
    expect(ofKind('keyTag').filter((d) => !ticketIds.has(d.data.currentTicketId ?? '')).map((d) => d.path)).toEqual([]);
  });

  it('every photo document and incident photo has a Storage object, sourced from a real file', () => {
    const storagePaths = new Set(dataset.storage.map((s) => s.path));
    const missing = [
      ...ofKind('photo').filter((d) => !storagePaths.has(d.data.storagePath)).map((d) => d.data.storagePath),
      ...ofKind('incident').flatMap((d) => d.data.photos.filter((p) => !storagePaths.has(p))),
    ];
    expect(missing).toEqual([]);
    for (const asset of DEMO_PHOTOS) {
      const file = join(__dirname, 'photos', asset.file);
      expect(statSync(file).size, asset.file).toBe(asset.bytes);
      // JPEG SOI marker: the seed uploads these with contentType image/jpeg.
      expect(readFileSync(file).subarray(0, 2).toString('hex'), asset.file).toBe('ffd8');
    }
  });
});

describe('demo dataset: server-side invariants the triggers enforce', () => {
  const docs = dataset.docs;
  const photosPerReport = new Map<string, number>();
  for (const d of docs) if (d.kind === 'photo') photosPerReport.set(d.path.split('/')[3] ?? '', (photosPerReport.get(d.path.split('/')[3] ?? '') ?? 0) + 1);

  it('drive-home jobs past inspection carry qualifying reports, written before the ticket', () => {
    const reportIndex = new Map(docs.flatMap((d, i) => (d.kind === 'damageReport' ? [[d.data.id, i] as const] : [])));
    const problems: string[] = [];
    docs.forEach((d, ticketIndex) => {
      if (d.kind !== 'ticket' || d.data.jobType !== 'drive_home') return;
      const needs: Array<'pre_drive' | 'post_drive'> = [];
      if (['in_transit', 'arrived', 'completed', 'closed'].includes(d.data.status)) needs.push('pre_drive');
      if (['completed', 'closed'].includes(d.data.status)) needs.push('post_drive');
      for (const phase of needs) {
        const report = docs.find((r): r is Extract<SeedDoc, { kind: 'damageReport' }> => r.kind === 'damageReport' && r.data.ticketId === d.data.id && r.data.phase === phase);
        if (!report) problems.push(`${d.data.status} ${d.data.id}: no ${phase} report`);
        else if ((report.data.photoCount ?? 0) < MIN_PRE_DRIVE_PHOTOS || (photosPerReport.get(report.data.id) ?? 0) < MIN_PRE_DRIVE_PHOTOS) problems.push(`${d.data.id}: ${phase} report under ${MIN_PRE_DRIVE_PHOTOS} photos`);
        else if ((reportIndex.get(report.data.id) ?? Infinity) > ticketIndex) problems.push(`${d.data.id}: ${phase} report written after the ticket`);
      }
    });
    expect(problems).toEqual([]);
  });

  it("completed jobs are seeded already paid, so onJobWritten doesn't attempt a live Stripe capture", () => {
    const authorizedCompleted = docs.filter((d) => d.kind === 'ticket' && ['completed', 'closed'].includes(d.data.status) && d.data.payment?.status === 'authorized');
    expect(authorizedCompleted.map((d) => d.path)).toEqual([]);
  });

  it('writes documents in the declared kind order', () => {
    const ranks = docs.map((d) => WRITE_ORDER.indexOf(d.kind));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(orderForWrite([...docs].reverse()).map((d) => d.kind)).toEqual(docs.map((d) => d.kind));
  });
});

describe('demo dataset: relative time', () => {
  const clock = demoClock(NOW);

  it("today's shifts are dated the venue-local today", () => {
    const today = ofKind('shift').find((d) => d.data.id === SHIFTS.stElmoToday);
    expect(today?.data.date).toBe(clock.localDay(0));
    expect(today?.data.status).toBe('open');
  });

  it(`has ${METRICS_DAYS} consecutive days of metrics ending today, and a forecast for this week`, () => {
    const days = ofKind('metricsDaily').map((d) => d.data.day);
    expect(days).toHaveLength(METRICS_DAYS);
    expect(days[0]).toBe(clock.localDay(0));
    expect(days.at(-1)).toBe(clock.localDay(METRICS_DAYS - 1));
    expect(ofKind('metricsForecast').map((d) => d.data.isoWeek)).toContain(isoWeek(clock.localDay(0)));
  });

  it('requested tickets show live SLA ages measured in minutes, not months', () => {
    const requested = ofKind('ticket').filter((d) => d.data.jobType === 'valet' && d.data.status === 'requested');
    const ages = requested.map((d) => (NOW.getTime() - Date.parse(d.data.times.requestedAt ?? '')) / 60_000);
    expect(ages.every((m) => m >= 0 && m <= 15)).toBe(true);
  });

  it('computes ISO weeks across a year boundary', () => {
    expect(isoWeek('2026-12-31')).toBe('2026-W53');
    expect(isoWeek('2027-01-04')).toBe('2027-W01');
    expect(isoWeek('2026-10-24')).toBe('2026-W43');
  });

  it('places venue-local wall-clock times in the right UTC instant (daylight time)', () => {
    // 2026-10-24 is EDT (UTC-4): 6pm local is 22:00Z.
    expect(clock.localTime(0, 18)).toBe('2026-10-24T22:00:00.000Z');
  });

  it('keeps every demo doc inside the goldstar tenant or the global collections', () => {
    const outside = dataset.docs.filter((d) => d.path !== `operators/${OP}` && !d.path.startsWith(`operators/${OP}/`) && !/^(operators\/(circlecity|northside)|invitations|guests|platform)\b/.test(d.path));
    expect(outside.map((d) => d.path)).toEqual([]);
  });
});
