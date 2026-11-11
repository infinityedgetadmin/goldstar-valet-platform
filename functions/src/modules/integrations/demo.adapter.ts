import type { SecretManagerClientLike } from './secretManager.adapter.js';

/**
 * In-memory Secret Manager client used only under the emulator-only demo switch
 * (lib/demoProviders.ts). It plugs into the REAL `GcpSecretManagerWriter`, so the adapter's
 * create-if-missing, ALREADY_EXISTS (gRPC code 6) swallow and version naming still run, and
 * `integrationsSetSecret` succeeds in the emulator, where no Secret Manager exists for
 * `demo-goldstar`. Values stay in this process's memory and are never logged.
 *
 * Nothing reads these values back: under the same switch, the POS/PMS registries return their demo
 * mocks without resolving credentials. So saving a secret in the demo shows the real UI result
 * ("saved", version recorded on the integration doc) without the value going anywhere.
 */
const versionsBySecret = new Map<string, number>();

export function demoSecretManagerClient(): SecretManagerClientLike {
  return {
    createSecret: ({ parent, secretId }) => {
      const name = `${parent}/secrets/${secretId}`;
      if (versionsBySecret.has(name)) return Promise.reject(Object.assign(new Error('ALREADY_EXISTS'), { code: 6 }));
      versionsBySecret.set(name, 0);
      return Promise.resolve([{ name }] as const);
    },
    addSecretVersion: ({ parent }) => {
      const next = (versionsBySecret.get(parent) ?? 0) + 1;
      versionsBySecret.set(parent, next);
      return Promise.resolve([{ name: `${parent}/versions/${next}` }] as const);
    },
  };
}
