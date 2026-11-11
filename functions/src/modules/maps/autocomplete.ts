import type { CallableOutput, CallableParsedInput } from '@goldstar/platform';
import { defineCallable, type Caller } from '../../lib/callable.js';
import type { Deps } from '../../lib/deps.js';
import { rateLimit } from '../guest/rateLimit.js';
import type { Geo, MapsProvider } from './port.js';
import { getMaps } from './registry.js';

export async function mapsAutocompleteHandler(
  deps: Deps,
  caller: Caller | null,
  input: CallableParsedInput<'mapsAutocomplete'>,
  maps: MapsProvider = getMaps(deps),
): Promise<CallableOutput<'mapsAutocomplete'>> {
  void caller; // allowAnonymous: true — the session token, not the caller, is the identity signal here
  // Rate-limit FIRST, deliberately unlike the token-resolving guest endpoints (guestCancel,
  // guestCreateCheckout: resolveToken before rateLimit, so a fabricated/expired token never writes
  // a rateLimits doc). `sessionToken` is a client-generated UUID, not a secret credential — there's
  // no cheaper validation to run before it (Zod's query.min(2)/sessionToken.min(8) already ran in
  // defineCallable), so there's nothing to save by deferring the limiter here.
  await rateLimit(deps, `maps:${input.sessionToken}`, 30, 60);
  const { suggestions } = await maps.autocomplete({
    query: input.query,
    sessionToken: input.sessionToken,
    ...(input.proximity !== undefined ? { proximity: input.proximity } : {}),
  });
  // Fill `geo` for the first 3 suggestions missing it (Search Box's suggest step never returns
  // coordinates — only retrieve does). Capped at 3 to bound the fan-out per autocomplete keystroke.
  const toFill = suggestions.map((s, idx) => ({ s, idx })).filter(({ s }) => !s.geo).slice(0, 3);
  const filledGeo = new Map<number, Geo>();
  await Promise.all(
    toFill.map(async ({ s, idx }) => {
      try {
        const r = await maps.retrieve({ id: s.id, sessionToken: input.sessionToken });
        filledGeo.set(idx, r.geo);
      } catch {
        // An individual retrieve failure degrades that one suggestion to geo-less rather than
        // failing the whole autocomplete call — the client can still show/select it by label.
      }
    }),
  );
  return { suggestions: suggestions.map((s, idx) => (filledGeo.has(idx) ? { ...s, geo: filledGeo.get(idx)! } : s)) };
}

export const mapsAutocomplete = defineCallable('mapsAutocomplete', { allowAnonymous: true, secrets: ['MAPBOX_SERVER_TOKEN'] }, mapsAutocompleteHandler);
