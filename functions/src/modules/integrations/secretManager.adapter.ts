import type { SecretWriter } from './port.js';

/**
 * Narrow, single-call-signature surface of `SecretManagerServiceClient` this adapter
 * actually depends on — same DI convention as `payments/stripe.adapter.ts`'s own
 * `StripeClientLike` (a hand-written narrow interface, distinct from `stripeClient.ts`'s
 * wide SDK-`Pick`, kept purely so a plain fake object can implement it directly instead
 * of matching the real client's 3-overload (promise/callback/callback-with-options)
 * method signatures). The real `SecretManagerServiceClient` (via `secretManagerClient()`)
 * satisfies this structurally — its promise overload's wider return tuple is assignable
 * to this narrower one — so `registry.ts` passes it in with no cast needed, exactly like
 * `payments/registry.ts` does for `StripeGateway`.
 */
export interface SecretManagerClientLike {
  createSecret(request: {
    parent: string;
    secretId: string;
    secret: { replication: { automatic: Record<string, never> } };
  }): Promise<readonly [{ name?: string | null }, ...unknown[]]>;
  addSecretVersion(request: { parent: string; payload: { data: Buffer } }): Promise<readonly [{ name?: string | null }, ...unknown[]]>;
}

/**
 * GCP Secret Manager-backed `SecretWriter`. Secrets are created lazily, one per
 * operator+provider+field (`operators-{op}-{provider}-{name}`) — there is no
 * provisioning step ahead of time, so `setSecret` must both create-if-missing and
 * write the value in one call.
 *
 * `replication: { automatic: {} }` is required by the real Secret Manager API on
 * `createSecret` (an unset replication policy is rejected server-side) even though
 * the installed client's `ICreateSecretRequest`/`ISecret` TypeScript types mark
 * every field optional — those types mirror the protobuf wire format, where every
 * proto3 field is technically optional, not the service's actual validation rules.
 * Verified against the installed `@google-cloud/secret-manager` v7 client's request/
 * response shapes directly (`secret_manager_service_client.d.ts` / `protos.d.ts`);
 * Context7's own README examples for `createSecret` omit `replication` entirely, but
 * that reads as the doc's own snippet being simplified for brevity, not as evidence
 * the field is actually optional server-side — so it's included here regardless.
 */
export class GcpSecretManagerWriter implements SecretWriter {
  constructor(
    private readonly client: SecretManagerClientLike,
    private readonly projectId: string,
  ) {}

  async setSecret(secretId: string, value: string): Promise<{ version: string }> {
    const parent = `projects/${this.projectId}`;
    const secretName = `${parent}/secrets/${secretId}`;
    try {
      await this.client.createSecret({ parent, secretId, secret: { replication: { automatic: {} } } });
    } catch (e) {
      // gRPC ALREADY_EXISTS = status code 6 (google.rpc.Code) — the only expected failure mode on a
      // secret this handler has already created for a previous call with the same operator/provider/
      // name. Anything else (bad project id, IAM denial, network) rethrows rather than being swallowed.
      if ((e as { code?: number }).code !== 6) throw e;
    }
    const [version] = await this.client.addSecretVersion({ parent: secretName, payload: { data: Buffer.from(value, 'utf8') } });
    if (!version.name) throw new Error('secret manager did not return a version name');
    return { version: version.name };
  }
}
