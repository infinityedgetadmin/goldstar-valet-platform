import { beforeEach, describe, expect, it } from 'vitest';
import { incidentCreatedHandler } from './incident.handler.js';
import { NOW, OP, TID, V1, seedOperator, testDeps, ticketDoc, wipe } from '../../../test/helpers.js';
import { P } from '../../lib/paths.js';

const IID = '01912345-7abc-7def-8123-456789abcd10';

function incidentDoc(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: IID, operatorId: OP, venueId: V1, type: 'damage', description: 'Scratch found at delivery', photos: [], reportedBy: 'att1', at: NOW, status: 'open', witnesses: [], ...over };
}

beforeEach(async () => {
  await wipe(testDeps());
});

/** Plan 8 Task 12: delivery is per manager uid, so every case needs at least one manager holding V1. */
async function seedLead(deps: ReturnType<typeof testDeps>) {
  await deps.db.doc(P.user(OP, 'lead1')).set({ uid: 'lead1', operatorId: OP, roles: ['lead'], venueIds: [V1], status: 'active', eligibility: { driveHome: false, passengerRide: false, reasons: [] }, createdAt: NOW, updatedAt: NOW });
}

describe('onIncidentCreated', () => {
  it('happy path (Plan 8 Task 12, #15): one pushEvent PER MANAGER UID of the venue — a lead holding it and an admin — never a topic, never an attendant or a lead elsewhere', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    const user = (uid: string, roles: string[], venueIds: string[]) => ({ uid, operatorId: OP, roles, venueIds, status: 'active', eligibility: { driveHome: false, passengerRide: false, reasons: [] }, createdAt: NOW, updatedAt: NOW });
    await deps.db.doc(P.user(OP, 'lead1')).set(user('lead1', ['lead'], [V1]));
    await deps.db.doc(P.user(OP, 'adm1')).set(user('adm1', ['admin'], []));
    await deps.db.doc(P.user(OP, 'att1')).set(user('att1', ['attendant'], [V1]));
    await deps.db.doc(P.user(OP, 'lead2')).set(user('lead2', ['lead'], ['v2'])); // a lead at another venue
    await deps.db.doc(P.user(OP, 'gone')).set({ ...user('gone', ['lead'], [V1]), status: 'suspended' });
    await deps.db.doc(P.ticket(OP, TID)).set(ticketDoc());
    await incidentCreatedHandler(deps, { operatorId: OP, incidentId: IID, data: incidentDoc({ ticketId: TID }) });
    const snap = await deps.db.collection('pushEvents').get();
    expect(snap.docs.map((d) => d.id).sort()).toEqual([`incident_${IID}_adm1`, `incident_${IID}_lead1`]);
    for (const d of snap.docs) {
      expect(d.data()).toMatchObject({ operatorId: OP, kind: 'incident.created', status: 'queued', data: { incidentId: IID, operatorId: OP, venueId: V1, type: 'damage', venue: 'St. Elmo', ref: 'ABC123' } });
      expect(d.data().toUid).toBe(d.id.split('_').pop());
      expect(Object.hasOwn(d.data(), 'toTopic')).toBe(false);
    }
  });

  it('schema-fail path: an invalid doc (missing description) is not enqueued and does not throw', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    const bad = incidentDoc();
    delete (bad as { description?: unknown }).description;
    await expect(incidentCreatedHandler(deps, { operatorId: OP, incidentId: IID, data: bad })).resolves.toBeUndefined();
    expect((await deps.db.collection('pushEvents').get()).size).toBe(0);
  });

  it('re-fire: a second invocation for the same incident does not duplicate or reset an already-sent pushEvent', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await seedLead(deps);
    await incidentCreatedHandler(deps, { operatorId: OP, incidentId: IID, data: incidentDoc() });
    const ref = deps.db.doc(`pushEvents/incident_${IID}_lead1`);
    await ref.update({ status: 'sent' }); // simulate the push worker having already delivered it
    await incidentCreatedHandler(deps, { operatorId: OP, incidentId: IID, data: incidentDoc() }); // redelivered trigger invocation
    expect((await deps.db.collection('pushEvents').get()).size).toBe(1);
    expect((await ref.get()).data()?.status).toBe('sent');
  });

  it('linked ticket without a plate on file falls back to a short ticket id ref', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await seedLead(deps);
    await deps.db.doc(P.ticket(OP, TID)).set(ticketDoc({ vehicle: { state: 'IN' } })); // no plate
    await incidentCreatedHandler(deps, { operatorId: OP, incidentId: IID, data: incidentDoc({ ticketId: TID }) });
    const doc = (await deps.db.doc(`pushEvents/incident_${IID}_lead1`).get()).data() as { data: Record<string, string> } | undefined;
    expect(doc?.data.ref).toBe(TID.slice(0, 8));
  });

  it('no linked ticket: payload has no ref field at all', async () => {
    const deps = testDeps();
    await seedOperator(deps);
    await seedLead(deps);
    await incidentCreatedHandler(deps, { operatorId: OP, incidentId: IID, data: incidentDoc() });
    const doc = (await deps.db.doc(`pushEvents/incident_${IID}_lead1`).get()).data();
    expect(doc?.data).not.toHaveProperty('ref');
    expect(doc?.ticketId).toBe('');
  });
});
