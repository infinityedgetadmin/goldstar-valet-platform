import { it } from 'vitest';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { ADMIN, ATT, OP, OWNER, PLATFORM, VENUE_USER, assertFails, seedTenant } from './helpers';

// Contracts v0.4.0 item 5c: `operators/{op}/integrationTokens/{provider}` holds QuickBooks'
// ROTATING refresh token — a live bearer credential for the operator's whole accounting file.
// The rule is `allow read, write: if false`, i.e. Functions-only via the Admin SDK.
//
// A Functions-only document that no test proves inaccessible is just a comment, so this asserts
// the denial from the strongest client principals rather than trusting the rule's wording.
// OWNER is the point of the test: owner is the most privileged operator-scoped role and the one
// that CAN read the sibling `integrations/{provider}` document, so proving owner is denied here is
// what proves the two paths really are separated.
it('integrationTokens is unreadable and unwritable by every client role, owner and platform_admin included', async () => {
  await seedTenant();
  const path = `operators/${OP}/integrationTokens/quickbooks_online`;

  // Reads — owner first: the role that reads `integrations/{provider}` fine, and must not read this.
  await assertFails(getDoc(doc(OWNER(), path)));
  await assertFails(getDoc(doc(ADMIN(), path)));
  await assertFails(getDoc(doc(PLATFORM(), path)));
  await assertFails(getDoc(doc(ATT(), path)));
  await assertFails(getDoc(doc(VENUE_USER(), path)));

  // Writes — a client must not be able to forge or overwrite a refresh token either.
  await assertFails(setDoc(doc(OWNER(), path), { provider: 'quickbooks_online', refreshToken: 'forged' }));
  await assertFails(setDoc(doc(PLATFORM(), path), { provider: 'quickbooks_online', refreshToken: 'forged' }));
});
