import { beforeEach, expect, it, vi } from 'vitest';
import { guestRequestDriveHomeHandler } from './requestDriveHome.js';
import type { MapsProvider } from '../maps/port.js';
import * as mapsRegistry from '../maps/registry.js';
import { NOW, OP, TID, TOKEN, seedOperator, testDeps, ticketDoc, wipe } from '../../../test/helpers.js';
import { P } from '../../lib/paths.js';
import { ticketWrittenHandler } from '../tickets/ticket.handler.js';

beforeEach(async () => {
  await wipe(testDeps());
});

interface JobView {
  id?: string;
  driveHome?: { quote?: unknown; route?: string; chase?: { status?: string } };
}

function useFakeMaps(overrides: Partial<MapsProvider> = {}): MapsProvider {
  const maps: MapsProvider = {
    autocomplete: () => Promise.reject(new Error('not stubbed')),
    retrieve: () => Promise.reject(new Error('not stubbed')),
    route: () => Promise.resolve({ distanceMeters: 16_093, durationSec: 900, polyline: 'enc_poly' }),
    ...overrides,
  };
  vi.spyOn(mapsRegistry, 'getMaps').mockReturnValue(maps);
  return maps;
}

async function seedParent(deps: ReturnType<typeof testDeps>, over: Record<string, unknown> = {}) {
  await seedOperator(deps);
  const t = ticketDoc(over);
  await deps.db.doc(P.ticket(OP, TID)).set(t);
  await ticketWrittenHandler(deps, { operatorId: OP, ticketId: TID, before: null, after: t });
}

it('creates a linked drive_home job with its own token, already quoted with an expiry, and appends it to the parent projection linkedJobs', async () => {
  const deps = testDeps();
  await seedParent(deps);
  useFakeMaps();
  const out = await guestRequestDriveHomeHandler(deps, null, { token: TOKEN, destination: { address: '1 Home St', geo: { lat: 39.8, lng: -86.1 } } });

  expect(out.jobToken).toMatch(/^[A-Za-z0-9_-]{22}$/);
  expect(out.jobToken).not.toBe(TOKEN);
  expect(out.quote.expiresAt).toBe(new Date(Date.parse(NOW) + 15 * 60_000).toISOString());

  const jobs = await deps.db.collection(`operators/${OP}/tickets`).where('parentTicketId', '==', TID).get();
  expect(jobs.size).toBe(1);
  const job = jobs.docs[0]!.data() as JobView;
  expect(job).toMatchObject({ jobType: 'drive_home', status: 'quoted', parentTicketId: TID, guestToken: out.jobToken });
  expect(job.driveHome?.quote).toEqual(out.quote);
  expect(job.driveHome?.route).toBe('enc_poly');
  expect(job.driveHome?.chase).toEqual({ status: 'pending' });

  // Own projection exists at the job's token, and — fix round 1 (Critical #2) — carries the quote
  // (with its expiry) and destination so a guest who reloads before confirming can resume into the
  // same quote/terms/confirm screen rather than a dead-end tracking view.
  const jobProj = (await deps.db.doc(P.guestTicket(out.jobToken)).get()).data() as {
    ticketId?: string;
    jobType?: string;
    status?: string;
    driveHome?: { quote?: unknown; destination?: { address?: string }; termsAcceptedAt?: string };
    ride?: unknown;
  };
  expect(jobProj).toMatchObject({ ticketId: job.id, jobType: 'drive_home', status: 'quoted' });
  expect(jobProj.driveHome?.quote).toEqual(out.quote);
  expect(jobProj.driveHome?.destination?.address).toBe('1 Home St');
  expect(jobProj.driveHome?.termsAcceptedAt).toBeUndefined(); // not yet confirmed
  expect(jobProj.ride).toBeUndefined();

  // Parent projection carries the linked job, but is otherwise UNAFFECTED — it never gains its own
  // driveHome/ride display block (that's the JOB's projection, not the valet parent's).
  const parentProj = (await deps.db.doc(P.guestTicket(TOKEN)).get()).data() as { linkedJobs?: unknown[]; driveHome?: unknown; ride?: unknown };
  expect(parentProj.linkedJobs).toEqual([{ ticketId: job.id, jobType: 'drive_home', status: 'quoted', token: out.jobToken }]);
  expect(parentProj.driveHome).toBeUndefined();
  expect(parentProj.ride).toBeUndefined();
});

it('rejects when the operator does not have drive_home enabled', async () => {
  const deps = testDeps();
  await seedParent(deps);
  await deps.db.doc(P.operator(OP)).update({ 'features.driveHome': false });
  useFakeMaps();
  await expect(
    guestRequestDriveHomeHandler(deps, null, { token: TOKEN, destination: { address: 'x', geo: { lat: 1, lng: 2 } } }),
  ).rejects.toMatchObject({ code: 'failed_precondition' });
});

it('rejects requesting a drive_home job from a non-valet (already-a-job) ticket', async () => {
  const deps = testDeps();
  await seedParent(deps, { jobType: 'drive_home', status: 'requested' });
  useFakeMaps();
  await expect(
    guestRequestDriveHomeHandler(deps, null, { token: TOKEN, destination: { address: 'x', geo: { lat: 1, lng: 2 } } }),
  ).rejects.toMatchObject({ code: 'failed_precondition' });
});
