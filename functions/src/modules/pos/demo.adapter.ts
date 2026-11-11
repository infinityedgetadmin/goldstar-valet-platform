import { MockPosProvider } from './mock.adapter.js';

/**
 * Open restaurant checks the Toast venue "has" during an emulator demo (lib/demoProviders.ts).
 * Integer cents. Tables are what a venue host types into "find check" in the venue portal.
 */
export const DEMO_POS_CHECKS: readonly { table: string; total: number; openedMinutesAgo: number }[] = [
  { table: '12', total: 8450, openedMinutesAgo: 52 },
  { table: '14', total: 13200, openedMinutesAgo: 35 },
  { table: '21', total: 4675, openedMinutesAgo: 18 },
];

let instance: MockPosProvider | null = null;

/**
 * One MockPosProvider per Functions-emulator worker process. The mock mints refs in seeding order
 * (`mock:1`, `mock:2`, ...), and every worker seeds the same checks in the same order, so a
 * `checkRef` returned by findCheck in one worker resolves to the same table in another. Validations
 * and charges applied in one worker are not visible to another; fine for a demo.
 */
export function demoPos(now: () => number = Date.now): MockPosProvider {
  if (!instance) {
    const pos = new MockPosProvider();
    for (const c of DEMO_POS_CHECKS) {
      pos.seedCheck({ table: c.table, total: c.total, openedAt: new Date(now() - c.openedMinutesAgo * 60_000).toISOString() });
    }
    instance = pos;
  }
  return instance;
}
