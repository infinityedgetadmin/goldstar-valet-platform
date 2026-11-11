import { createHmac } from 'node:crypto';
import type { MessagingProvider } from './port.js';
import type { TwilioLike } from './twilioClient.js';

export class TwilioProvider implements MessagingProvider {
  constructor(private readonly c: TwilioLike) {}

  async send(i: { to: string; body: string; config: { messagingServiceSid?: string; fromNumber?: string }; statusCallbackUrl?: string }) {
    const m = await this.c.messages.create({
      to: i.to,
      body: i.body,
      // exactOptionalPropertyTypes: never spread `{ from: i.config.fromNumber }` when fromNumber is
      // absent — that would hand the SDK call an explicit `from: undefined` property, which the
      // (plain-optional, no `| undefined`) `from?: string` param type rejects.
      ...(i.config.messagingServiceSid ? { messagingServiceSid: i.config.messagingServiceSid } : i.config.fromNumber !== undefined ? { from: i.config.fromNumber } : {}),
      ...(i.statusCallbackUrl ? { statusCallback: i.statusCallbackUrl } : {}),
    });
    return { providerRef: m.sid };
  }

  /** Twilio signature = base64(HMAC-SHA1(authToken, url + sorted(key+value)...)). Implemented locally so the check is testable without the SDK's argument-order ambiguity. */
  verifyWebhook(i: { url: string; params: Record<string, string>; signature: string; authToken: string }): boolean {
    // noUncheckedIndexedAccess types i.params[k] as string | undefined even though k always comes
    // from Object.keys(i.params) (so the lookup can never actually miss) — `?? ''` satisfies the
    // checker without changing behavior.
    const data = i.url + Object.keys(i.params).sort().map((k) => k + (i.params[k] ?? '')).join('');
    const expected = createHmac('sha1', i.authToken).update(data).digest('base64');
    // 'x' is a fixed, public key, not a secret — it only needs to make each side's HMAC avalanche
    // (one differing input byte flips ~half the output bits), which decorrelates the ===-comparison's
    // early-exit timing from *where* expected/i.signature first diverge.
    return expected.length === i.signature.length && createHmac('sha256', 'x').update(expected).digest('hex') === createHmac('sha256', 'x').update(i.signature).digest('hex');
  }
}
