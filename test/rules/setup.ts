import { initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach } from 'vitest';
export let env: RulesTestEnvironment;
// Emulator port isolation (infra task, task-platform-report.md): `initializeTestEnvironment`
// takes an explicit numeric `port`, not a `*_EMULATOR_HOST` string — it never reads the Admin
// SDK's env vars itself, so there's no "prefer what firebase already injected" fallback available
// here the way functions/test/setup.ts has; `GOLDSTAR_EMU_FIRESTORE_PORT`/`_STORAGE_PORT` (set by
// `scripts/emulator-config.mjs`'s offset wrapper, same vars/same defaults as the functions suite)
// are the only source of truth.
beforeAll(async () => {
  env = await initializeTestEnvironment({
    // Per-offset project id (carry #70): derived ONLY by scripts/emulator-config.mjs and exported as
    // GOLDSTAR_EMU_PROJECT_ID. Must match what the emulator was started with, or singleProjectMode
    // rejects every request. `demo-goldstar` is the offset-0 value, never an independent choice.
    projectId: process.env.GOLDSTAR_EMU_PROJECT_ID ?? 'demo-goldstar',
    firestore: { rules: readFileSync('firestore.rules', 'utf8'), host: '127.0.0.1', port: Number(process.env.GOLDSTAR_EMU_FIRESTORE_PORT ?? 8080) },
    storage: { rules: readFileSync('storage.rules', 'utf8'), host: '127.0.0.1', port: Number(process.env.GOLDSTAR_EMU_STORAGE_PORT ?? 9199) },
  });
});
beforeEach(async () => { await env.clearFirestore(); await env.clearStorage(); });
afterAll(async () => { await env.cleanup(); });
