import { SecretManagerServiceClient } from '@google-cloud/secret-manager';

// Narrowed to exactly the two RPCs `secretManager.adapter.ts` calls — same structural-port
// convention as `stripeClient.ts`'s `StripeLike`/`twilioClient.ts`'s `TwilioLike`, so tests
// substitute a plain object satisfying this type instead of the full generated client.
export type SecretManagerLike = Pick<SecretManagerServiceClient, 'createSecret' | 'addSecretVersion'>;

let cached: SecretManagerServiceClient | null = null;

export function secretManagerClient(): SecretManagerLike {
  if (!cached) cached = new SecretManagerServiceClient();
  return cached;
}
