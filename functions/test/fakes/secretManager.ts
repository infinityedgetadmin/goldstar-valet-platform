import type { SecretWriter } from '../../src/modules/integrations/port.js';
import type { SecretManagerClientLike } from '../../src/modules/integrations/secretManager.adapter.js';

/**
 * In-memory stand-in for `SecretWriter` — used by handler-level tests
 * (`setSecret.test.ts`) that don't need to exercise `GcpSecretManagerWriter`'s own
 * create-then-add-version logic, only that the handler calls it correctly.
 */
export class FakeSecretWriter implements SecretWriter {
  calls: { secretId: string; value: string }[] = [];
  fail = false;

  async setSecret(secretId: string, value: string): Promise<{ version: string }> {
    if (this.fail) throw new Error('secret manager down');
    this.calls.push({ secretId, value });
    return { version: `projects/demo-goldstar/secrets/${secretId}/versions/1` };
  }
}

/**
 * Fake of `secretManager.adapter.ts`'s own narrow `SecretManagerClientLike` — used by
 * `secretManager.adapter.test.ts` to exercise `GcpSecretManagerWriter`'s logic
 * (create-if-missing, ALREADY_EXISTS swallow, version-name propagation) without a real
 * Secret Manager call. `existing` seeds secret ids that should already exist, so
 * `createSecret` for them throws a gRPC-shaped ALREADY_EXISTS (code 6) error, mirroring
 * what the real client throws and what the adapter catches.
 */
export class FakeSecretManagerClient implements SecretManagerClientLike {
  existing = new Set<string>();
  createCalls: { parent: string; secretId: string }[] = [];
  addVersionCalls: { parent: string; data: string }[] = [];
  nextCreateError: unknown = null;
  nextVersionName: string | null | undefined;

  async createSecret(request: { parent: string; secretId: string }): Promise<readonly [{ name?: string | null }, ...unknown[]]> {
    if (this.existing.has(request.secretId)) {
      const e = new Error('6 ALREADY_EXISTS: Secret already exists') as Error & { code: number };
      e.code = 6;
      throw e;
    }
    if (this.nextCreateError) throw this.nextCreateError;
    this.createCalls.push({ parent: request.parent, secretId: request.secretId });
    this.existing.add(request.secretId);
    return [{ name: `${request.parent}/secrets/${request.secretId}` }];
  }

  async addSecretVersion(request: { parent: string; payload: { data: Buffer } }): Promise<readonly [{ name?: string | null }, ...unknown[]]> {
    this.addVersionCalls.push({ parent: request.parent, data: request.payload.data.toString('utf8') });
    const name = this.nextVersionName !== undefined ? this.nextVersionName : `${request.parent}/versions/1`;
    return [{ name }];
  }
}
