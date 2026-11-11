import type { ProviderContext, ScheduleProvider, SyncResult } from './port.js';

// The default provider for operators that run scheduling entirely in-app (no external
// system to reconcile against). `sync` is intentionally a no-op — internal shifts are
// written directly by staff via the shifts collection, never through the sync pipeline.
// Params are named (not dropped) so the concrete class keeps the port's full 2-arg
// signature — the test below calls `.sync(...)` directly on the class, not through the
// `ScheduleProvider` interface, so arity has to match here too. Declared rather than
// `async` + no `await` (would trip `@typescript-eslint/require-await`).
export class InternalScheduleProvider implements ScheduleProvider {
  kind = 'internal';

  sync(ctx: ProviderContext, range: { from: string; to: string }): Promise<SyncResult> {
    void ctx; void range; // unused — no-op adapter; `void` reads keep no-unused-vars quiet without an eslint config change
    return Promise.resolve({ upserted: 0, errors: [], shifts: [] });
  }

  healthCheck(ctx: ProviderContext): Promise<{ ok: boolean }> {
    void ctx;
    return Promise.resolve({ ok: true });
  }
}
