// Emulator port isolation (infra task, task-platform-report.md): `??=`, not `=` — defers to
// whatever `firebase emulators:exec` (or `scripts/emulator-config.mjs`'s offset wrapper) already
// injected into this process's env, so two differently-offset emulator suites can run
// concurrently without one gate's setupFile clobbering the other's ports. `GOLDSTAR_EMU_*_PORT`
// is the fallback for the rarer case where nothing already set the `*_EMULATOR_HOST` var (e.g. a
// manually-started `npm run emulators` at a custom offset, paired with `vitest` run directly
// rather than through `emulators:exec`) — same pattern `scripts/seed-emulator.ts` already used
// for these same three vars.
process.env.FIRESTORE_EMULATOR_HOST ??= `127.0.0.1:${process.env.GOLDSTAR_EMU_FIRESTORE_PORT ?? '8080'}`;
process.env.FIREBASE_AUTH_EMULATOR_HOST ??= `127.0.0.1:${process.env.GOLDSTAR_EMU_AUTH_PORT ?? '9099'}`;
process.env.FIREBASE_STORAGE_EMULATOR_HOST ??= `127.0.0.1:${process.env.GOLDSTAR_EMU_STORAGE_PORT ?? '9199'}`;
// Per-offset project id (carry #70): derived only by scripts/emulator-config.mjs. `=` not `??=` on
// purpose — this must equal the id the emulator started with, and a stale GCLOUD_PROJECT inherited
// from the shell would silently point the Admin SDK at a different namespace on the same emulator.
process.env.GCLOUD_PROJECT = process.env.GOLDSTAR_EMU_PROJECT_ID ?? 'demo-goldstar';
process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_x';
