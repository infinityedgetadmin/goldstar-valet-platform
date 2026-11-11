import { beforeEach, describe, expect, it, vi } from 'vitest';
import { integrationsSetSecretHandler } from './setSecret.js';
import { FakeSecretWriter } from '../../../test/fakes/secretManager.js';
import { OP, seedOperator, testDeps, wipe } from '../../../test/helpers.js';
import { P } from '../../lib/paths.js';
import * as registry from './registry.js';

beforeEach(async () => {
  await wipe(testDeps());
});

function useFake() {
  const fake = new FakeSecretWriter();
  vi.spyOn(registry, 'getSecretWriter').mockReturnValue(fake);
  return fake;
}

describe('integrationsSetSecretHandler', () => {
  it('owner: writes to Secret Manager under the operators-{op}-{provider}-{name} id and stores secretRef', async () => {
    const deps = testDeps();
    const fake = useFake();
    await seedOperator(deps);
    const out = await integrationsSetSecretHandler(deps, { uid: 'owner1', operatorId: OP, roles: ['owner'], venueIds: [] }, {
      provider: 'twilio',
      name: 'authToken',
      value: 'tok_super_secret',
    });
    expect(fake.calls).toEqual([{ secretId: 'operators-goldstar-twilio-authToken', value: 'tok_super_secret' }]);
    expect(out).toEqual({ secretRef: 'operators-goldstar-twilio-authToken' });
    const integ = (await deps.db.doc(P.integration(OP, 'twilio')).get()).data() as { secretRef?: string } | undefined;
    expect(integ?.secretRef).toBe('operators-goldstar-twilio-authToken');
  });

  it('never writes the secret value into Firestore — only the secretRef pointer', async () => {
    const deps = testDeps();
    useFake();
    await seedOperator(deps);
    await integrationsSetSecretHandler(deps, { uid: 'owner1', operatorId: OP, roles: ['owner'], venueIds: [] }, {
      provider: 'twilio',
      name: 'authToken',
      value: 'tok_super_secret',
    });
    const integ = (await deps.db.doc(P.integration(OP, 'twilio')).get()).data() as Record<string, unknown> | undefined;
    expect(JSON.stringify(integ)).not.toContain('tok_super_secret');
  });

  it('merges into the integration doc — an existing config field survives', async () => {
    const deps = testDeps();
    useFake();
    await seedOperator(deps);
    await deps.db.doc(P.integration(OP, 'twilio')).set({ config: { messagingServiceSid: 'MG_x' }, status: 'configured' });
    await integrationsSetSecretHandler(deps, { uid: 'owner1', operatorId: OP, roles: ['owner'], venueIds: [] }, {
      provider: 'twilio',
      name: 'authToken',
      value: 'tok_1',
    });
    const integ = (await deps.db.doc(P.integration(OP, 'twilio')).get()).data() as { config?: { messagingServiceSid?: string }; status?: string; secretRef?: string } | undefined;
    expect(integ).toMatchObject({ config: { messagingServiceSid: 'MG_x' }, status: 'configured', secretRef: 'operators-goldstar-twilio-authToken' });
  });

  it('records an audit entry naming the field, never the value', async () => {
    const deps = testDeps();
    useFake();
    await seedOperator(deps);
    await integrationsSetSecretHandler(deps, { uid: 'owner1', operatorId: OP, roles: ['owner'], venueIds: [] }, {
      provider: 'twilio',
      name: 'authToken',
      value: 'tok_super_secret',
    });
    const auditSnap = await deps.db.collection(`operators/${OP}/auditLog`).get();
    expect(auditSnap.docs).toHaveLength(1);
    const entry = auditSnap.docs[0]!.data() as { action: string; target: string };
    expect(entry).toMatchObject({ action: 'integrations.setSecret', target: 'twilio.authToken' });
    expect(JSON.stringify(entry)).not.toContain('tok_super_secret');
  });

  it('non-owner, non-platform_admin staff is denied', async () => {
    const deps = testDeps();
    useFake();
    await seedOperator(deps);
    await expect(
      integrationsSetSecretHandler(deps, { uid: 'admin1', operatorId: OP, roles: ['admin'], venueIds: [] }, { provider: 'twilio', name: 'authToken', value: 'x' }),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('unauthenticated caller is denied', async () => {
    const deps = testDeps();
    useFake();
    await seedOperator(deps);
    await expect(
      integrationsSetSecretHandler(deps, null, { provider: 'twilio', name: 'authToken', value: 'x' }),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('owner is blocked when the operator is suspended (Ruling C-2)', async () => {
    const deps = testDeps();
    useFake();
    await seedOperator(deps);
    await deps.db.doc(P.operator(OP)).update({ status: 'suspended' });
    await expect(
      integrationsSetSecretHandler(deps, { uid: 'owner1', operatorId: OP, roles: ['owner'], venueIds: [] }, { provider: 'twilio', name: 'authToken', value: 'x' }),
    ).rejects.toMatchObject({ code: 'failed_precondition' });
  });

  it('an assumed platform_admin (roles: platform_admin+admin) bypasses the suspended-operator gate', async () => {
    const deps = testDeps();
    const fake = useFake();
    await seedOperator(deps);
    await deps.db.doc(P.operator(OP)).update({ status: 'suspended' });
    const out = await integrationsSetSecretHandler(deps, { uid: 'pa1', operatorId: OP, roles: ['platform_admin', 'admin'], venueIds: [] }, {
      provider: 'twilio',
      name: 'authToken',
      value: 'fixed_value',
    });
    expect(out).toEqual({ secretRef: 'operators-goldstar-twilio-authToken' });
    expect(fake.calls).toHaveLength(1);
  });

  it('venue-scoped provider + venueId: writes under the composite {provider}_{venueId} doc id', async () => {
    const deps = testDeps();
    const fake = useFake();
    await seedOperator(deps);
    const out = await integrationsSetSecretHandler(deps, { uid: 'owner1', operatorId: OP, roles: ['owner'], venueIds: [] }, {
      provider: 'opera_cloud',
      name: 'clientSecret',
      value: 'x',
      venueId: 'v1',
    });
    expect(fake.calls).toEqual([{ secretId: 'operators-goldstar-opera_cloud_v1-clientSecret', value: 'x' }]);
    expect(out).toEqual({ secretRef: 'operators-goldstar-opera_cloud_v1-clientSecret' });
    const integ = (await deps.db.doc(P.integration(OP, 'opera_cloud_v1')).get()).data() as { secretRef?: string } | undefined;
    expect(integ?.secretRef).toBe('operators-goldstar-opera_cloud_v1-clientSecret');
  });

  it('rejects venueId for an operator-scoped provider', async () => {
    const deps = testDeps();
    useFake();
    await seedOperator(deps);
    await expect(
      integrationsSetSecretHandler(deps, { uid: 'owner1', operatorId: OP, roles: ['owner'], venueIds: [] }, {
        provider: 'twilio',
        name: 'authToken',
        value: 'x',
        venueId: 'v1',
      }),
    ).rejects.toMatchObject({ code: 'invalid_argument' });
  });

  it('rejects a missing venueId for a venue-scoped provider', async () => {
    const deps = testDeps();
    useFake();
    await seedOperator(deps);
    await expect(
      integrationsSetSecretHandler(deps, { uid: 'owner1', operatorId: OP, roles: ['owner'], venueIds: [] }, {
        provider: 'opera_cloud',
        name: 'clientSecret',
        value: 'x',
      }),
    ).rejects.toMatchObject({ code: 'invalid_argument' });
  });

  it('propagates a Secret Manager failure without writing secretRef or auditing', async () => {
    const deps = testDeps();
    const fake = useFake();
    fake.fail = true;
    await seedOperator(deps);
    await expect(
      integrationsSetSecretHandler(deps, { uid: 'owner1', operatorId: OP, roles: ['owner'], venueIds: [] }, { provider: 'twilio', name: 'authToken', value: 'x' }),
    ).rejects.toThrow('secret manager down');
    const integ = (await deps.db.doc(P.integration(OP, 'twilio')).get()).data();
    expect(integ).toBeUndefined();
    const auditSnap = await deps.db.collection(`operators/${OP}/auditLog`).get();
    expect(auditSnap.docs).toHaveLength(0);
  });
});
