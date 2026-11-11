import { readFileSync } from 'node:fs';

// Loaded via readFileSync + JSON.parse rather than a `.json` import specifier: the base tsconfig
// (NodeNext, no `resolveJsonModule`) would need a config change either project-wide or via an
// import-attribute (`with { type: 'json' }`) at every call site to type-check a JSON import — this
// sidesteps both and needs no tsconfig change.
function loadFixture(name: 'suggest' | 'retrieve' | 'directions'): unknown {
  return JSON.parse(readFileSync(new URL(`../fixtures/mapbox/${name}.json`, import.meta.url), 'utf8'));
}

export const mapboxFixtures = {
  suggest: loadFixture('suggest'),
  retrieve: loadFixture('retrieve'),
  directions: loadFixture('directions'),
};

// A fake `fetch` for MapboxMaps (which takes `fetchFn` in its constructor, the same
// client-injection shape StripeGateway/TwilioProvider use). By default it routes a call to the
// fixture matching the URL's endpoint, so a test only sets `status`/`body`/`fail`/`hang` when it
// wants to exercise an error path; every call's exact URL is captured in `calls` for assertion.
export class FakeMapbox {
  calls: string[] = [];
  status: number | null = null;
  body: unknown = null;
  // When set, used verbatim as the response body text instead of `JSON.stringify(body)` — lets a
  // test simulate a malformed (non-JSON) response (Ruling AF) without fighting `JSON.stringify`,
  // which can't itself be made to produce invalid JSON.
  raw: string | null = null;
  fail = false;
  hang = false;

  // Typed as `typeof fetch` (not a hand-written narrower signature) so it's assignable straight
  // into `MapboxMaps`'s `fetchFn: typeof fetch` constructor param with no cast.
  fetch: typeof fetch = (input, init) => {
    this.calls.push(String(input));
    if (this.fail) return Promise.reject(new TypeError('fetch failed'));
    if (this.hang) {
      // Never resolves on its own — only settles (rejects) once MapboxMaps' own AbortController
      // fires, exactly as a real hung connection would behave once the adapter's timeout aborts it.
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted', 'AbortError'));
        });
      });
    }
    const path = new URL(String(input)).pathname;
    const fixtureBody = this.body ?? (path.endsWith('/suggest') ? mapboxFixtures.suggest : path.includes('/retrieve/') ? mapboxFixtures.retrieve : mapboxFixtures.directions);
    const bodyText = this.raw ?? JSON.stringify(fixtureBody);
    return Promise.resolve(new Response(bodyText, { status: this.status ?? 200 }));
  };
}
