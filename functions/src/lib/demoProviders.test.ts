import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { operatorSchema, venueSchema, type Operator, type Venue } from '@goldstar/platform';
import { DEMO_PROVIDERS_FLAG, demoProvidersEnabled } from './demoProviders.js';
import { P } from './paths.js';
import type { Deps } from './deps.js';
import { getVision } from '../modules/vision/registry.js';
import { MockPlateRecognition } from '../modules/vision/mock.adapter.js';
import { PlateRecognizerProvider } from '../modules/vision/plateRecognizer.adapter.js';
import { getMessaging } from '../modules/messaging/registry.js';
import { getEmail } from '../modules/messaging/email.js';
import { getPms } from '../modules/pms/registry.js';
import { getPos } from '../modules/pos/registry.js';
import { getSecretWriter } from '../modules/integrations/registry.js';
import * as secretManagerClientModule from '../modules/integrations/secretManagerClient.js';
import { OP, V1, seedOperator, testDeps, wipe } from '../../test/helpers.js';

/** A `deps.secrets` that fails loudly, to prove which code path reads vendor credentials. */
const NO_SECRETS = new Error('test: vendor credentials were read');
function depsWithoutSecrets(): Deps {
  return testDeps({ secrets: { get: () => { throw NO_SECRETS; } } });
}

function enableDemo() {
  vi.stubEnv(DEMO_PROVIDERS_FLAG, '1');
  vi.stubEnv('FUNCTIONS_EMULATOR', 'true');
}

async function loadOperator(deps: Deps, over: Record<string, unknown> = {}): Promise<Operator> {
  await seedOperator(deps);
  if (Object.keys(over).length > 0) await deps.db.doc(P.operator(OP)).update(over);
  return operatorSchema.parse((await deps.db.doc(P.operator(OP)).get()).data());
}

async function loadVenue(deps: Deps, over: Record<string, unknown> = {}): Promise<Venue> {
  await seedOperator(deps);
  if (Object.keys(over).length > 0) await deps.db.doc(P.venue(OP, V1)).update(over);
  return venueSchema.parse((await deps.db.doc(P.venue(OP, V1)).get()).data());
}

const PMS = { pms: { provider: 'opera_cloud', hotelId: 'H1', noPostBehavior: 'block', chargeCode: 'VALET' } };
const POS = { pos: { provider: 'toast', restaurantGuid: 'rg_demo' } };

beforeEach(async () => {
  vi.restoreAllMocks();
  await wipe(testDeps());
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('demoProvidersEnabled', () => {
  it('is off when the flag is absent, even under the emulator', () => {
    expect(demoProvidersEnabled({ FUNCTIONS_EMULATOR: 'true' })).toBe(false);
  });

  it('is off for any flag value other than "1"', () => {
    for (const value of ['true', '0', 'yes', '']) {
      expect(demoProvidersEnabled({ [DEMO_PROVIDERS_FLAG]: value, FUNCTIONS_EMULATOR: 'true' })).toBe(false);
    }
  });

  it('is on only when the flag is "1" AND the Functions emulator is running', () => {
    expect(demoProvidersEnabled({ [DEMO_PROVIDERS_FLAG]: '1', FUNCTIONS_EMULATOR: 'true' })).toBe(true);
  });

  it('production guard: the flag without the emulator stays off and warns exactly once', async () => {
    vi.resetModules();
    const fresh = await import('./demoProviders.js');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(fresh.demoProvidersEnabled({ [DEMO_PROVIDERS_FLAG]: '1' })).toBe(false);
    expect(fresh.demoProvidersEnabled({ [DEMO_PROVIDERS_FLAG]: '1', FUNCTIONS_EMULATOR: 'false' })).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('only run under the Functions emulator');
  });

  it('reads process.env by default', () => {
    enableDemo();
    expect(demoProvidersEnabled()).toBe(true);
  });
});

describe('vision registry', () => {
  it('demo on: a plate_recognizer operator gets the scripted mock and no token is read', async () => {
    const op = await loadOperator(testDeps(), { 'modules.vision.provider': 'plate_recognizer' });
    enableDemo();
    const vision = getVision(depsWithoutSecrets(), op);
    expect(vision).toBeInstanceOf(MockPlateRecognition);
    await expect(vision.readPlate({ bytes: Buffer.from([0xff, 0xd8]) })).resolves.toMatchObject({ plate: 'ABC123', state: 'IN' });
  });

  it('demo off: the real Plate Recognizer adapter', async () => {
    const op = await loadOperator(testDeps(), { 'modules.vision.provider': 'plate_recognizer' });
    expect(getVision(testDeps(), op)).toBeInstanceOf(PlateRecognizerProvider);
  });

  it('demo on does not turn on an operator configured with provider "none"', async () => {
    const op = await loadOperator(testDeps());
    enableDemo();
    expect(() => getVision(testDeps(), op)).toThrow(/plate OCR is not configured/);
  });
});

describe('SMS (messaging registry)', () => {
  it('demo on: sends succeed with a demo ref and Twilio credentials are never read', async () => {
    const op = await loadOperator(testDeps());
    enableDemo();
    const { providerRef } = await getMessaging(depsWithoutSecrets(), op).send({ to: '+13175550123', body: 'Your car is ready', config: { messagingServiceSid: 'MG_x' } });
    expect(providerRef).toMatch(/^SMdemo\d{6}$/);
  });

  it('demo off: the real Twilio path reads credentials', async () => {
    const op = await loadOperator(testDeps());
    expect(() => getMessaging(depsWithoutSecrets(), op)).toThrow(NO_SECRETS);
  });
});

describe('email (getEmail)', () => {
  it('demo on: sends succeed with a demo ref and the Resend key is never read', async () => {
    enableDemo();
    const { providerRef } = await getEmail(depsWithoutSecrets()).send({ to: 'host@example.com', subject: 'Invite', html: '<p>hi</p>', from: 'Goldstar <no-reply@example.com>' });
    expect(providerRef).toMatch(/^re_demo_\d{6}$/);
  });

  it('demo off: the real Resend path reads the API key', () => {
    expect(() => getEmail(depsWithoutSecrets())).toThrow(NO_SECRETS);
  });
});

describe('PMS registry', () => {
  it('demo on: a PMS venue gets the demo hotel, with lookups and room charges working', async () => {
    const deps = testDeps();
    const venue = await loadVenue(deps, PMS);
    enableDemo();
    const pms = await getPms(deps, OP, venue);
    await expect(pms.lookupReservation({ room: '1204' })).resolves.toEqual({ reservations: [expect.objectContaining({ guestName: 'Avery Collins', reservationRef: 'demo_res_1204', noPost: false })] });
    const { postingRef } = await pms.postCharge({ reservationRef: 'demo_res_1204', amount: 2500, currency: 'USD', chargeCode: 'VALET', description: 'Valet', referenceId: 't1' });
    expect(postingRef).toMatch(/^mock_\d+$/);
  });

  it('demo on: the no-post reservation still refuses charges', async () => {
    const deps = testDeps();
    const venue = await loadVenue(deps, PMS);
    enableDemo();
    const pms = await getPms(deps, OP, venue);
    await expect(pms.postCharge({ reservationRef: 'demo_res_1530', amount: 2500, currency: 'USD', chargeCode: 'VALET', description: 'Valet', referenceId: 't2' })).rejects.toMatchObject({ code: 'failed_precondition' });
  });

  it('demo on still requires venue.pms', async () => {
    const deps = testDeps();
    const venue = await loadVenue(deps);
    enableDemo();
    await expect(getPms(deps, OP, venue)).rejects.toMatchObject({ code: 'failed_precondition' });
  });

  it('demo off: the honest provider_unavailable', async () => {
    const deps = testDeps();
    const venue = await loadVenue(deps, PMS);
    await expect(getPms(deps, OP, venue)).rejects.toMatchObject({ code: 'provider_unavailable' });
  });
});

describe('POS registry', () => {
  it('demo on: a Toast venue gets the demo checks, validations apply, and no Toast credentials are read', async () => {
    const deps = depsWithoutSecrets();
    const venue = await loadVenue(testDeps(), POS);
    enableDemo();
    const pos = await getPos(deps, OP, venue);
    const { checks } = await pos.findCheck({ table: '21' });
    expect(checks).toEqual([expect.objectContaining({ table: '21', total: 4675 })]);
    const checkRef = checks[0]?.checkRef ?? '';
    await expect(pos.applyValidation({ checkRef, amount: 1000, reason: 'VAL-DEMO' })).resolves.toEqual({ ok: true });
    await expect(pos.findCheck({ checkRef })).resolves.toEqual({ checks: [expect.objectContaining({ total: 3675 })] });
  });

  it('demo on still requires venue.pos', async () => {
    const deps = testDeps();
    const venue = await loadVenue(deps);
    enableDemo();
    await expect(getPos(deps, OP, venue)).rejects.toMatchObject({ code: 'failed_precondition' });
  });

  it('demo off: the real Toast path reads credentials', async () => {
    const venue = await loadVenue(testDeps(), POS);
    await expect(getPos(depsWithoutSecrets(), OP, venue)).rejects.toBe(NO_SECRETS);
  });
});

describe('Secret Manager (integrations registry)', () => {
  it('demo on: secrets save through the real writer with versions counting up, and no GCP client is built', async () => {
    const realClient = vi.spyOn(secretManagerClientModule, 'secretManagerClient');
    enableDemo();
    const writer = getSecretWriter(testDeps());
    const first = await writer.setSecret('operators-goldstar-toast-clientId', 'value-1');
    const second = await writer.setSecret('operators-goldstar-toast-clientId', 'value-2');
    expect(first.version).toMatch(/\/secrets\/operators-goldstar-toast-clientId\/versions\/1$/);
    expect(second.version).toMatch(/\/secrets\/operators-goldstar-toast-clientId\/versions\/2$/);
    expect(realClient).not.toHaveBeenCalled();
  });

  it('demo off: the real Secret Manager client is used', () => {
    const realClient = vi.spyOn(secretManagerClientModule, 'secretManagerClient').mockReturnValue({
      createSecret: () => Promise.reject(new Error('unused')),
      addSecretVersion: () => Promise.reject(new Error('unused')),
    });
    getSecretWriter(testDeps());
    expect(realClient).toHaveBeenCalledTimes(1);
  });
});
