import { readFileSync } from 'node:fs';

export const plateRecognizerFixtures = {
  reader: JSON.parse(readFileSync(new URL('../fixtures/plateRecognizer/reader.json', import.meta.url), 'utf8')) as unknown,
};

/**
 * A fake `fetch` for PlateRecognizerProvider — same shape as FakeMapbox. Captures every call's URL
 * and init (headers + the multipart body) so a test can assert the exact wire contract; routes to
 * the reader fixture unless `status`/`body`/`raw`/`fail`/`hang` say otherwise. `statuses` lets a
 * test script one status per call (the 429-then-200 retry path).
 */
export class FakePlateRecognizer {
  calls: { url: string; init: RequestInit | undefined }[] = [];
  status: number | null = null;
  statuses: number[] = [];
  body: unknown = null;
  raw: string | null = null;
  fail = false;
  hang = false;

  fetch: typeof fetch = (input, init) => {
    this.calls.push({ url: String(input), init });
    if (this.fail) return Promise.reject(new TypeError('fetch failed'));
    if (this.hang) {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted', 'AbortError'));
        });
      });
    }
    const status = this.statuses.length > 0 ? this.statuses.shift()! : (this.status ?? 200);
    const bodyText = this.raw ?? JSON.stringify(this.body ?? plateRecognizerFixtures.reader);
    return Promise.resolve(new Response(bodyText, { status }));
  };
}
