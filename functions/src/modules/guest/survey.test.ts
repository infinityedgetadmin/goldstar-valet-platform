import { beforeEach, expect, it } from 'vitest';
import { guestSurveyHandler } from './survey.js';
import { resolveToken } from './token.js';
import { NOW, OP, TID, TOKEN, seedOperator, testDeps, ticketDoc, wipe } from '../../../test/helpers.js';
import { P } from '../../lib/paths.js';

const FUTURE = '2030-01-01T00:00:00.000Z';

beforeEach(async () => {
  await wipe(testDeps());
});

async function seedClosedTicket(deps: ReturnType<typeof testDeps>, over: Record<string, unknown> = {}) {
  await seedOperator(deps);
  const t = ticketDoc({ status: 'closed', guestToken: TOKEN, ...over });
  await deps.db.doc(P.ticket(OP, TID)).set(t);
  await deps.db.doc(P.guestTicket(TOKEN)).set({ operatorId: OP, ticketId: TID, expiresAt: FUTURE });
  return t;
}

it('RULING AG: resolveToken\'s DEFAULT stays strict — the same closed ticket the survey accepts still throws ticket_closed without the flag', async () => {
  const deps = testDeps();
  await seedClosedTicket(deps);
  await expect(resolveToken(deps, TOKEN)).rejects.toMatchObject({ code: 'ticket_closed' });
  await expect(resolveToken(deps, TOKEN, { allowTerminal: true })).resolves.toMatchObject({ operatorId: OP });
});

it('RULING C: accepts a survey for a CLOSED ticket — the one status every other guest callable rejects', async () => {
  const deps = testDeps();
  await seedClosedTicket(deps);
  const out = await guestSurveyHandler(deps, null, { token: TOKEN, score: 5, comment: 'Fast and friendly' });
  expect(out).toEqual({ ok: true });

  const s = (await deps.db.doc(P.survey(TID)).get()).data()!;
  expect(s).toEqual({ id: TID, operatorId: OP, venueId: 'v1', ticketId: TID, score: 5, comment: 'Fast and friendly', at: NOW });
});

it('one survey per ticket: a duplicate submit is an idempotent ok — the first response is never overwritten', async () => {
  const deps = testDeps();
  await seedClosedTicket(deps);
  await guestSurveyHandler(deps, null, { token: TOKEN, score: 5 });
  const out = await guestSurveyHandler(deps, null, { token: TOKEN, score: 1, comment: 'changed my mind' });
  expect(out).toEqual({ ok: true });
  const s = (await deps.db.doc(P.survey(TID)).get()).data()!;
  expect(s.score).toBe(5);
  expect(s.comment).toBeUndefined();
});

it('rejects a token with no projection, an expired projection, and a token mismatch — all as guest_token_expired', async () => {
  const deps = testDeps();
  await seedOperator(deps);
  await expect(guestSurveyHandler(deps, null, { token: TOKEN, score: 4 })).rejects.toMatchObject({ code: 'guest_token_expired' });

  await deps.db.doc(P.guestTicket(TOKEN)).set({ operatorId: OP, ticketId: TID, expiresAt: '2020-01-01T00:00:00.000Z' });
  await expect(guestSurveyHandler(deps, null, { token: TOKEN, score: 4 })).rejects.toMatchObject({ code: 'guest_token_expired' });

  await deps.db.doc(P.guestTicket(TOKEN)).set({ operatorId: OP, ticketId: TID, expiresAt: FUTURE });
  await deps.db.doc(P.ticket(OP, TID)).set(ticketDoc({ status: 'closed', guestToken: 'BbCdEfGhIjKlMnOpQrStUv' }));
  await expect(guestSurveyHandler(deps, null, { token: TOKEN, score: 4 })).rejects.toMatchObject({ code: 'guest_token_expired' });
});

it('rate limits per token (5/60): the sixth call in the window rejects', async () => {
  const deps = testDeps();
  await seedClosedTicket(deps);
  for (let i = 0; i < 5; i++) await guestSurveyHandler(deps, null, { token: TOKEN, score: 5 });
  await expect(guestSurveyHandler(deps, null, { token: TOKEN, score: 5 })).rejects.toMatchObject({ code: 'rate_limited' });
});
