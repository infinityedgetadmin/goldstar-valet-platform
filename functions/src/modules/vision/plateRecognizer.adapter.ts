import { err } from '../../lib/errors.js';
import type { PlateCandidate, PlateReadResult, PlateRecognitionProvider } from './port.js';

/**
 * Plate Recognizer Snapshot (cloud) adapter.
 *
 * WIRE CONTRACT — verified against the vendor's own reference client
 * (github.com/parkpow/deep-license-plate-recognition, plate_recognition.py), not memory:
 *   POST https://api.platerecognizer.com/v1/plate-reader/
 *   headers: Authorization: Token <api key>
 *   multipart/form-data: `upload` = the image; `regions` repeated once per region code (e.g. `us`);
 *   optional `camera_id`, `mmc`, `config` (JSON), `timestamp`.
 *   429 = the per-second call cap ("Max calls per second reached"); the reference client sleeps 1s
 *   and retries up to 3 times. Response: { results: [{ plate, score, dscore, box, region?, candidates?,
 *   vehicle? }], usage, processing_time, camera_id, timestamp, filename }.
 *
 * `region` and `candidates` are read by the reference client but not shown in its README's JSON
 * sample, so both are typed OPTIONAL and runtime-guarded here — a response without them degrades
 * to "no state / the single result is the only candidate", never to a throw.
 */
const ENDPOINT = 'https://api.platerecognizer.com/v1/plate-reader/';
const TIMEOUT_MS = 8_000;
const RATE_LIMIT_RETRY_MS = 1_000;

interface ReaderResult {
  plate?: string;
  score?: number;
  region?: { code?: string; score?: number };
  candidates?: { plate?: string; score?: number }[];
}
interface ReaderResponse {
  results?: ReaderResult[];
}

export class PlateRecognizerProvider implements PlateRecognitionProvider {
  constructor(
    private readonly fetchFn: typeof fetch,
    private readonly opts: { token: string; region?: string },
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  async readPlate(i: { bytes: Buffer; region?: string }): Promise<PlateReadResult> {
    const region = i.region ?? this.opts.region;
    const body = (): FormData => {
      const fd = new FormData();
      fd.append('upload', new Blob([new Uint8Array(i.bytes)], { type: 'image/jpeg' }), 'plate.jpg');
      if (region) fd.append('regions', region);
      return fd;
    };
    let res: Response | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, TIMEOUT_MS);
      try {
        res = await this.fetchFn(ENDPOINT, { method: 'POST', headers: { Authorization: `Token ${this.opts.token}` }, body: body(), signal: controller.signal });
      } catch (e) {
        // Name only — never the message, which can embed the request. A hung or failed connection
        // is the provider being unavailable, which the client already renders as retry-later copy.
        console.error('plateRecognizer fetch failed', { name: e instanceof Error ? e.name : typeof e });
        throw err('provider_unavailable', 'plate recognizer');
      } finally {
        clearTimeout(timer);
      }
      // 429 is the vendor's per-second cap, not a quota: wait one second and try once more.
      if (res.status === 429 && attempt === 0) {
        await this.sleep(RATE_LIMIT_RETRY_MS);
        continue;
      }
      break;
    }
    if (!res || res.status < 200 || res.status >= 300) throw err('provider_unavailable', `plate recognizer ${res?.status ?? 'no response'}`);
    let parsed: ReaderResponse;
    try {
      parsed = (await res.json()) as ReaderResponse;
    } catch {
      throw err('provider_unavailable', 'plate recognizer: malformed response');
    }
    return mapReaderResponse(parsed);
  }
}

const normalisePlate = (p: string): string => p.toUpperCase().replace(/[^A-Z0-9-]/g, '');

/** `us-in` → `IN`; anything not a two-part US code yields no state rather than a guess. */
export function stateFromRegionCode(code: string | undefined): string | undefined {
  if (!code) return undefined;
  const m = /^us-([a-z]{2})$/i.exec(code.trim());
  return m ? m[1]!.toUpperCase() : undefined;
}

export function mapReaderResponse(r: ReaderResponse): PlateReadResult {
  const first = r.results?.[0];
  if (!first || typeof first.plate !== 'string' || first.plate.length === 0) return { confidence: 0, candidates: [] };
  const plate = normalisePlate(first.plate);
  const confidence = clamp01(first.score);
  const raw = Array.isArray(first.candidates) && first.candidates.length > 0 ? first.candidates : [{ plate: first.plate, score: first.score }];
  const candidates: PlateCandidate[] = raw
    .filter((c): c is { plate: string; score?: number } => typeof c.plate === 'string' && c.plate.length > 0)
    .map((c) => ({ plate: normalisePlate(c.plate), confidence: clamp01(c.score) }));
  const state = stateFromRegionCode(first.region?.code);
  return { plate, confidence, candidates, ...(state !== undefined ? { state } : {}) };
}

function clamp01(n: number | undefined): number {
  if (typeof n !== 'number' || Number.isNaN(n)) return 0;
  return Math.min(1, Math.max(0, n));
}
