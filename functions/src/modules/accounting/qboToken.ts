import type { IntegrationToken } from '@goldstar/platform';
import type { Deps } from '../../lib/deps.js';
import { err } from '../../lib/errors.js';
import { P } from '../../lib/paths.js';

// Verified via Context7 (developer.intuit.com OAuth 2.0 docs) before implementation:
// endpoint, Basic(clientId:clientSecret) auth, x-www-form-urlencoded body, and the response
// carrying the ROTATED refresh_token + x_refresh_token_expires_in (100 days, seconds).
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
/** Refresh the cached access token 5 minutes before Intuit's stated expiry (expires_in: 3600). */
const ACCESS_SAFETY_MS = 5 * 60_000;

interface RefreshResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  x_refresh_token_expires_in: number;
  token_type: string;
}

/**
 * Returns a live QBO access token for the operator, refreshing (and ROTATING) when needed.
 *
 * THE TOKEN MODEL (the ruling that reshaped the brief): Intuit returns a NEW refresh token on
 * every refresh and invalidates the old one — the refresh token is mutable STATE, not
 * configuration, so it lives at `operators/{op}/integrationTokens/quickbooks_online`
 * (Functions-only; never client-readable) and NOT in Secret Manager, which is read-only at
 * runtime. The original design would have broken on its second refresh while passing every test.
 *
 * THE TRANSACTIONAL REQUIREMENT: the rotated token is written in a transaction that RE-READS
 * the doc and verifies it still holds the token we consumed. Two instances refreshing
 * concurrently: Intuit honors one; the loser gets invalid_grant, re-reads the doc, and uses the
 * winner's stored access token instead of wedging. If the doc advanced past what we consumed
 * (the winner committed first), ours is DISCARDED — first-writer-wins, because there is no way
 * to order two responses and overwriting would orphan the winner's refresh token.
 *
 * The residual crash window — Intuit issued a new token, we died before the write — is the
 * documented no-programmatic-recovery case (`integrationTokenSchema`'s own comment): the old
 * token is invalid, the new one is lost, a human re-authorizes through OAuth consent. The write
 * happens IMMEDIATELY after the HTTP call to keep that window as narrow as it can be.
 */
export async function getQboAccessToken(
  deps: Deps,
  operatorId: string,
  creds: { clientId: string; clientSecret: string },
  fetchFn: typeof fetch = fetch,
): Promise<{ accessToken: string; realmId?: string | undefined }> {
  const tokenRef = deps.db.doc(P.integrationToken(operatorId, 'quickbooks_online'));
  const doc = (await tokenRef.get()).data() as IntegrationToken | undefined;
  if (!doc?.refreshToken) throw err('failed_precondition', 'quickbooks not connected — authorize through the OAuth consent flow first');

  const nowMs = Date.parse(deps.now());
  if (doc.accessToken && doc.accessTokenExpiresAt && Date.parse(doc.accessTokenExpiresAt) - ACCESS_SAFETY_MS > nowMs) {
    return { accessToken: doc.accessToken, realmId: doc.realmId };
  }

  const consumed = doc.refreshToken;
  const res = await fetchFn(TOKEN_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64')}`,
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: consumed }).toString(),
  });
  if (!res.ok) {
    if (res.status === 400 || res.status === 401) {
      // Likely invalid_grant — a concurrent refresher may have rotated first. Re-read; if the
      // doc advanced, use the winner's token instead of failing the request.
      const fresh = (await tokenRef.get()).data() as IntegrationToken | undefined;
      if (fresh && fresh.refreshToken !== consumed && fresh.accessToken && fresh.accessTokenExpiresAt && Date.parse(fresh.accessTokenExpiresAt) > Date.parse(deps.now())) {
        return { accessToken: fresh.accessToken, realmId: fresh.realmId };
      }
      throw err('failed_precondition', 'quickbooks authorization expired — re-authorize through the OAuth consent flow');
    }
    throw err('provider_unavailable', 'quickbooks token refresh failed');
  }
  const body = (await res.json()) as RefreshResponse;

  const rotated = await deps.db.runTransaction(async (tx) => {
    const current = (await tx.get(tokenRef)).data() as IntegrationToken | undefined;
    if (!current || current.refreshToken !== consumed) return false; // a concurrent refresher won — first-writer-wins
    tx.update(tokenRef, {
      refreshToken: body.refresh_token,
      refreshTokenExpiresAt: new Date(Date.parse(deps.now()) + body.x_refresh_token_expires_in * 1000).toISOString(),
      accessToken: body.access_token,
      accessTokenExpiresAt: new Date(Date.parse(deps.now()) + body.expires_in * 1000).toISOString(),
      rotatedAt: deps.now(),
      rotationCount: current.rotationCount + 1,
    });
    return true;
  });
  if (!rotated) {
    const winner = (await tokenRef.get()).data() as IntegrationToken | undefined;
    if (winner?.accessToken) return { accessToken: winner.accessToken, realmId: winner.realmId };
  }
  return { accessToken: body.access_token, realmId: doc.realmId };
}
