import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { CUSTODY_ACTIONS } from '../schemas/ticket';
import { VALET_RULES } from './valet';
it('firestore.rules generated block contains every TS transition', () => {
  const rules = readFileSync('firestore.rules', 'utf8');
  for (const r of VALET_RULES) if (r.from) expect(rules).toContain(`(from == '${r.from}' && to == '${r.to}')`);
});
// Ruling AC (finding 7): custodyActionValid() is hand-written (outside the generated markers), so there
// is no generator to keep it in sync with CUSTODY_ACTIONS — only a test can catch divergence. Checks
// both directions: every TS action must appear in the rule, and the rule must not carry an action TS
// doesn't know about.
it('firestore.rules custodyActionValid() matches CUSTODY_ACTIONS exactly', () => {
  const rules = readFileSync('firestore.rules', 'utf8');
  const match = rules.match(/function custodyActionValid\(a\) \{[\s\S]*?\n {6}\}/);
  expect(match).toBeTruthy();
  const body = match![0];
  const matchedActions = [...body.matchAll(/a == '([a-z_]+)'/g)].map((m) => m[1]);
  expect(matchedActions.length).toBe(CUSTODY_ACTIONS.length);
  expect(new Set(matchedActions)).toEqual(new Set(CUSTODY_ACTIONS));
});
