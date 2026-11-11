import twilio from 'twilio';

export type TwilioLike = {
  messages: {
    create: (p: { to: string; body: string; messagingServiceSid?: string; from?: string; statusCallback?: string }) => Promise<{ sid: string; status: string }>;
  };
};

let cached: TwilioLike | null = null;

export function twilioClient(sid: string, token: string): TwilioLike {
  if (!cached) cached = twilio(sid, token);
  return cached;
}

export const twilioValidate = twilio.validateRequest;
