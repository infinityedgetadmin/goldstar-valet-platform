import type { ResendLike } from './email.js';
import type { TwilioLike } from './twilioClient.js';

/**
 * In-process stand-ins for the Twilio and Resend SDK clients, used only under the emulator-only
 * demo switch (lib/demoProviders.ts). They plug into the REAL `TwilioProvider` / `ResendProvider`
 * through their narrow client types, so the adapters' own request shaping and sender.ts's
 * status handling still run. Only the network hop is skipped. Every send "succeeds" with a unique
 * `demo_` provider ref, and sender.ts records the outbound doc as `sent`.
 *
 * Deliberately separate from test/fakes/{twilio,resend}.ts: those record calls and expose failure
 * toggles for assertions, and test-only code is not part of the deployed bundle.
 *
 * Logs carry the provider ref only, never the recipient or body, so demo logs hold no guest PII.
 */
let smsCount = 0;
let emailCount = 0;

export function demoTwilioClient(): TwilioLike {
  return {
    messages: {
      create: () => {
        const sid = `SMdemo${String(++smsCount).padStart(6, '0')}`;
        console.info('demo provider: SMS accepted without sending', { providerRef: sid });
        return Promise.resolve({ sid, status: 'queued' });
      },
    },
  };
}

export function demoResendClient(): ResendLike {
  return {
    emails: {
      send: () => {
        const id = `re_demo_${String(++emailCount).padStart(6, '0')}`;
        console.info('demo provider: email accepted without sending', { providerRef: id });
        return Promise.resolve({ data: { id }, error: null });
      },
    },
  };
}
