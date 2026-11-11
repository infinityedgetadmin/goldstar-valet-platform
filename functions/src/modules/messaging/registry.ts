import type { Operator } from '@goldstar/platform';
import type { Deps } from '../../lib/deps.js';
import { demoProvidersEnabled } from '../../lib/demoProviders.js';
import { err } from '../../lib/errors.js';
import { demoTwilioClient } from './demo.adapter.js';
import type { MessagingProvider } from './port.js';
import { TwilioProvider } from './twilio.adapter.js';
import { twilioClient } from './twilioClient.js';

export function getMessaging(deps: Deps, op: Operator): MessagingProvider {
  // Widened to `string`: MESSAGING_PROVIDERS (src/schemas/operator.ts) currently has a single
  // member, so the field's literal type is just `'twilio'` and a switch over it is tautological
  // to the type checker. Widening keeps this registry a real dispatch point as providers are
  // added, instead of eslint's `no-unnecessary-condition` flagging the only-case-that-exists today.
  const provider: string = op.modules.messaging.provider;
  switch (provider) {
    case 'twilio':
      // Emulator-only demo switch: the real adapter over an in-process client, and no Twilio
      // credentials are read (lib/demoProviders.ts, ./demo.adapter.ts).
      if (demoProvidersEnabled()) return new TwilioProvider(demoTwilioClient());
      return new TwilioProvider(twilioClient(deps.secrets.get('TWILIO_ACCOUNT_SID'), deps.secrets.get('TWILIO_AUTH_TOKEN')));
    default:
      throw err('provider_unavailable', `messaging provider ${provider}`);
  }
}
