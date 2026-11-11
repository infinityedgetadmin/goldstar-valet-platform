import type { Auth } from 'firebase-admin/auth';
import type { Firestore } from 'firebase-admin/firestore';
import type { Storage } from 'firebase-admin/storage';
import { adminAuth, adminDb, adminStorage } from './app.js';
import { uuidv7 } from '@goldstar/platform';

export interface SecretReader {
  get(name: string): string;
}

export interface Deps {
  db: Firestore;
  auth: Auth;
  storage: Storage;
  now: () => string;
  requestId: string;
  secrets: SecretReader;
  newId: () => string;
  /**
   * The calling client's IP, resolved once per request by `defineCallable` via `callable.ts`'s
   * `ipFrom` and threaded through here (Task 5 fix round 1, Ruling J) — never via `Caller.ip`.
   * `Caller` can legitimately be `null` for an anonymous `allowAnonymous` call, so it isn't a safe
   * carrier for data every handler might need regardless of auth state; `Deps` already is (every
   * handler receives it unconditionally, same as `now`/`requestId`). Riding on `Deps` rather than a
   * new trailing handler parameter also sidesteps a real collision: `mapsAutocompleteHandler`
   * already uses positional parameter 4 for its own `MapsProvider` dependency injection, so a
   * generically-threaded 4th `ip` argument broke it at compile time (`maps: MapsProvider` vs.
   * `ip?: string` — a real type error, not a style nit) the first time this was tried. `undefined`
   * for any call this repo makes outside a real `defineCallable`-wrapped HTTPS request (Firestore
   * triggers, scripts, tests that don't explicitly set it via `testDeps({ callerIp: ... })`).
   */
  callerIp?: string;
}

export function makeDeps(over: Partial<Deps> = {}): Deps {
  return {
    db: adminDb,
    auth: adminAuth,
    storage: adminStorage,
    now: () => new Date().toISOString(),
    requestId: uuidv7(),
    secrets: {
      get: (n) => {
        const v = process.env[n];
        if (!v) throw new Error(`missing secret ${n}`);
        return v;
      },
    },
    newId: uuidv7,
    ...over,
  };
}
