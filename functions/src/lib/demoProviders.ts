/**
 * Emulator-only "demo providers" switch, for demos run against the local emulators (project
 * `demo-goldstar`). When on, the vendor registries return in-process fakes instead of live
 * adapters: plate OCR, SMS, email, hotel PMS, Toast POS and Secret Manager. Those flows then
 * complete without vendor accounts. Payments (Stripe) are deliberately NOT covered: a fake gateway
 * would let checkout and refund screens appear to move money, so demos show payment states as
 * seeded data instead.
 *
 * Both conditions are required, so this can never activate in a deployed function:
 * - `GOLDSTAR_DEMO_PROVIDERS === '1'`, the explicit opt-in. functions/.env.demo-goldstar sets it,
 *   and firebase-tools loads `.env.<projectId>` only for that project id (verified in the installed
 *   firebase-tools 14.27.0, lib/functions/env.js `findEnvfiles`). No deploy target is `demo-*`.
 * - `FUNCTIONS_EMULATOR === 'true'`, which the Functions emulator sets for every runtime it spawns
 *   (firebase-tools 14.27.0, lib/emulator/functionsEmulator.js) and Cloud Functions never sets.
 *
 * If the flag is set outside the emulator, this warns once per instance and stays on the real
 * providers.
 */
export const DEMO_PROVIDERS_FLAG = 'GOLDSTAR_DEMO_PROVIDERS';

let warnedOutsideEmulator = false;

export function demoProvidersEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  if (env[DEMO_PROVIDERS_FLAG] !== '1') return false;
  if (env.FUNCTIONS_EMULATOR === 'true') return true;
  if (!warnedOutsideEmulator) {
    warnedOutsideEmulator = true;
    console.warn(`${DEMO_PROVIDERS_FLAG}=1 ignored: demo providers only run under the Functions emulator`);
  }
  return false;
}
