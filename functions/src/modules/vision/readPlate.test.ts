import { beforeEach, describe, expect, it } from 'vitest';
import { visionReadPlateHandler } from './readPlate.js';
import { MockPlateRecognition } from './mock.adapter.js';
import { NOW, OP, TID, V1, seedOperator, testDeps, ticketDoc, wipe } from '../../../test/helpers.js';
import { P } from '../../lib/paths.js';
import type { Caller } from '../../lib/callable.js';

const ATT: Caller = { uid: 'att1', operatorId: OP, roles: ['attendant'], venueIds: [V1] };
const PATH = `operators/${OP}/tickets/${TID}/photos/01912345-7abc-7def-8123-456789abcde6.jpg`;
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);

beforeEach(async () => {
  await wipe(testDeps());
});

async function seedEnabled(deps: ReturnType<typeof testDeps>) {
  await seedOperator(deps);
  await deps.db.doc(P.operator(OP)).update({ 'features.plateOcr': true, 'modules.vision.provider': 'plate_recognizer' });
  await deps.storage.bucket().file(PATH).save(jpeg, { contentType: 'image/jpeg' });
}

describe('visionReadPlate', () => {
  it('reads the uploaded photo through the provider and returns the read; no prior ticket → no knownGuest', async () => {
    const deps = testDeps();
    await seedEnabled(deps);
    const out = await visionReadPlateHandler(deps, ATT, { storagePath: PATH }, new MockPlateRecognition());
    expect(out).toEqual({ plate: 'ABC123', state: 'IN', confidence: 0.91, candidates: [{ plate: 'ABC123', confidence: 0.91 }, { plate: 'A8C123', confidence: 0.06 }] });
    expect(Object.hasOwn(out, 'knownGuest')).toBe(false);
  });

  it('returning guest: the operator\'s most recent ticket for that plate yields phoneLast4 + last venue, never the phone number', async () => {
    const deps = testDeps();
    await seedEnabled(deps);
    await deps.db.doc(P.ticket(OP, '01912345-7abc-7def-8123-456789abcd01')).set(ticketDoc({ id: '01912345-7abc-7def-8123-456789abcd01', vehicle: { plate: 'ABC123', state: 'IN' }, times: { checkedInAt: '2026-08-01T10:00:00.000Z' } }));
    await deps.db.doc(P.ticket(OP, '01912345-7abc-7def-8123-456789abcd02')).set(ticketDoc({ id: '01912345-7abc-7def-8123-456789abcd02', vehicle: { plate: 'ABC123', state: 'IN' }, guest: { phoneE164: '+13175559999', phoneLast4: '9999', consentSms: true }, times: { checkedInAt: NOW } }));
    const out = await visionReadPlateHandler(deps, ATT, { storagePath: PATH }, new MockPlateRecognition());
    expect(out.knownGuest).toEqual({ phoneLast4: '9999', lastVenueId: V1, lastVenueName: 'St. Elmo', lastSeenAt: NOW }); // the LATER ticket wins
    expect(JSON.stringify(out)).not.toContain('+1317');
  });

  it('a read with no plate never looks up a guest', async () => {
    const deps = testDeps();
    await seedEnabled(deps);
    const out = await visionReadPlateHandler(deps, ATT, { storagePath: PATH }, new MockPlateRecognition({ confidence: 0, candidates: [] }));
    expect(out).toEqual({ confidence: 0, candidates: [] });
  });

  it('SECURITY: a path outside the caller\'s operator tree — another operator, a traversal, a non-ticket path — is permission_denied before any read', async () => {
    const deps = testDeps();
    await seedEnabled(deps);
    for (const bad of [`operators/valetb/tickets/${TID}/photos/x.jpg`, `operators/${OP}/tickets/../../valetb/tickets/${TID}/photos/x.jpg`, `operators/${OP}/branding/logo.jpg`, `operators/${OP}/tickets//x.jpg`]) {
      await expect(visionReadPlateHandler(deps, ATT, { storagePath: bad }, new MockPlateRecognition())).rejects.toMatchObject({ code: 'permission_denied' });
    }
  });

  it('feature off → failed_precondition; provider none → failed_precondition; missing object → not_found; a guest caller is refused', async () => {
    const deps = testDeps();
    await seedOperator(deps); // plateOcr false, provider 'none'
    await expect(visionReadPlateHandler(deps, ATT, { storagePath: PATH }, new MockPlateRecognition())).rejects.toMatchObject({ code: 'failed_precondition' });
    await deps.db.doc(P.operator(OP)).update({ 'features.plateOcr': true });
    await deps.storage.bucket().file(PATH).save(jpeg, { contentType: 'image/jpeg' });
    await expect(visionReadPlateHandler(deps, ATT, { storagePath: PATH })).rejects.toMatchObject({ code: 'failed_precondition' }); // registry: provider 'none'
    await expect(visionReadPlateHandler(deps, ATT, { storagePath: PATH.replace('abcde6', 'abcde7') }, new MockPlateRecognition())).rejects.toMatchObject({ code: 'not_found' });
    await expect(visionReadPlateHandler(deps, { uid: 'g1', roles: ['guest'], venueIds: [], phone: '+13175550123' }, { storagePath: PATH }, new MockPlateRecognition())).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('rate limit: the 31st read in the window is rate_limited', async () => {
    const deps = testDeps();
    await seedEnabled(deps);
    for (let i = 0; i < 30; i += 1) await visionReadPlateHandler(deps, ATT, { storagePath: PATH }, new MockPlateRecognition());
    await expect(visionReadPlateHandler(deps, ATT, { storagePath: PATH }, new MockPlateRecognition())).rejects.toMatchObject({ code: 'rate_limited' });
  });
});
