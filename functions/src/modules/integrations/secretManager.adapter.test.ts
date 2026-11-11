import { describe, expect, it } from 'vitest';
import { GcpSecretManagerWriter } from './secretManager.adapter.js';
import { FakeSecretManagerClient } from '../../../test/fakes/secretManager.js';

describe('GcpSecretManagerWriter', () => {
  it('creates the secret then adds a version, sending the value as the version payload', async () => {
    const client = new FakeSecretManagerClient();
    const writer = new GcpSecretManagerWriter(client, 'demo-goldstar');
    const out = await writer.setSecret('operators-goldstar-twilio-authToken', 'tok_123');
    expect(client.createCalls).toEqual([{ parent: 'projects/demo-goldstar', secretId: 'operators-goldstar-twilio-authToken' }]);
    expect(client.addVersionCalls).toEqual([
      { parent: 'projects/demo-goldstar/secrets/operators-goldstar-twilio-authToken', data: 'tok_123' },
    ]);
    expect(out.version).toBe('projects/demo-goldstar/secrets/operators-goldstar-twilio-authToken/versions/1');
  });

  it('sends replication: automatic on create (Secret Manager rejects an unset replication policy)', async () => {
    const client = new FakeSecretManagerClient();
    let seen: unknown;
    const originalCreate = client.createSecret.bind(client);
    client.createSecret = async (request) => {
      seen = request;
      return originalCreate(request);
    };
    const writer = new GcpSecretManagerWriter(client, 'demo-goldstar');
    await writer.setSecret('operators-goldstar-twilio-authToken', 'x');
    expect(seen).toMatchObject({ secret: { replication: { automatic: {} } } });
  });

  it('swallows ALREADY_EXISTS (code 6) on create and still adds a new version', async () => {
    const client = new FakeSecretManagerClient();
    client.existing.add('operators-goldstar-twilio-authToken');
    const writer = new GcpSecretManagerWriter(client, 'demo-goldstar');
    const out = await writer.setSecret('operators-goldstar-twilio-authToken', 'rotated');
    expect(client.createCalls).toEqual([]); // never actually created — already existed
    expect(client.addVersionCalls).toEqual([
      { parent: 'projects/demo-goldstar/secrets/operators-goldstar-twilio-authToken', data: 'rotated' },
    ]);
    expect(out.version).toContain('versions/1');
  });

  it('rethrows a create failure that is not ALREADY_EXISTS', async () => {
    const client = new FakeSecretManagerClient();
    client.nextCreateError = Object.assign(new Error('permission denied'), { code: 7 });
    const writer = new GcpSecretManagerWriter(client, 'demo-goldstar');
    await expect(writer.setSecret('operators-goldstar-twilio-authToken', 'x')).rejects.toThrow('permission denied');
  });

  it('throws if Secret Manager returns no version name', async () => {
    const client = new FakeSecretManagerClient();
    client.nextVersionName = null;
    const writer = new GcpSecretManagerWriter(client, 'demo-goldstar');
    await expect(writer.setSecret('operators-goldstar-twilio-authToken', 'x')).rejects.toThrow('did not return a version name');
  });
});
