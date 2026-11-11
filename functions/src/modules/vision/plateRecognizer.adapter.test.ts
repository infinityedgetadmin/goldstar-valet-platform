import { describe, expect, it } from 'vitest';
import { PlateRecognizerProvider, mapReaderResponse, stateFromRegionCode } from './plateRecognizer.adapter.js';
import { FakePlateRecognizer } from '../../../test/fakes/plateRecognizer.js';

const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const noSleep = () => Promise.resolve();

describe('PlateRecognizerProvider — wire contract (verified against the vendor reference client)', () => {
  it('POSTs multipart to /v1/plate-reader/ with Authorization: Token, the image under `upload`, and `regions`', async () => {
    const fake = new FakePlateRecognizer();
    const p = new PlateRecognizerProvider(fake.fetch, { token: 'tok_test', region: 'us' }, noSleep);
    await p.readPlate({ bytes });
    expect(fake.calls).toHaveLength(1);
    const { url, init } = fake.calls[0]!;
    expect(url).toBe('https://api.platerecognizer.com/v1/plate-reader/');
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Token tok_test');
    const fd = init?.body as FormData;
    expect(fd).toBeInstanceOf(FormData);
    const upload = fd.get('upload');
    expect(upload).toBeInstanceOf(Blob);
    expect((upload as Blob).type).toBe('image/jpeg');
    expect(fd.getAll('regions')).toEqual(['us']);
  });

  it('maps the fixture: normalised uppercase plate, score as confidence, region us-in → state IN, candidates in order', async () => {
    const fake = new FakePlateRecognizer();
    const p = new PlateRecognizerProvider(fake.fetch, { token: 't' }, noSleep);
    expect(await p.readPlate({ bytes })).toEqual({
      plate: 'ABC123', state: 'IN', confidence: 0.904,
      candidates: [{ plate: 'ABC123', confidence: 0.904 }, { plate: 'A8C123', confidence: 0.061 }],
    });
  });

  it('empty results → no plate, confidence 0, no candidates (not a throw — "no plate in the photo" is a valid read)', () => {
    expect(mapReaderResponse({ results: [] })).toEqual({ confidence: 0, candidates: [] });
    expect(mapReaderResponse({})).toEqual({ confidence: 0, candidates: [] });
  });

  it('a result without region or candidates degrades to no state and a single self-candidate', () => {
    expect(mapReaderResponse({ results: [{ plate: 'xyz789', score: 0.5 }] })).toEqual({ plate: 'XYZ789', confidence: 0.5, candidates: [{ plate: 'XYZ789', confidence: 0.5 }] });
    expect(stateFromRegionCode('us-in')).toBe('IN');
    expect(stateFromRegionCode('mx')).toBeUndefined();
    expect(stateFromRegionCode(undefined)).toBeUndefined();
  });

  it('429 (the per-second cap) is retried exactly once after the sleep, then succeeds', async () => {
    const fake = new FakePlateRecognizer();
    fake.statuses = [429, 200];
    const slept: number[] = [];
    const p = new PlateRecognizerProvider(fake.fetch, { token: 't' }, (ms) => { slept.push(ms); return Promise.resolve(); });
    const out = await p.readPlate({ bytes });
    expect(out.plate).toBe('ABC123');
    expect(fake.calls).toHaveLength(2);
    expect(slept).toEqual([1000]);
  });

  it('a second 429 is provider_unavailable — never an unbounded retry against a metered API', async () => {
    const fake = new FakePlateRecognizer();
    fake.statuses = [429, 429];
    const p = new PlateRecognizerProvider(fake.fetch, { token: 't' }, noSleep);
    await expect(p.readPlate({ bytes })).rejects.toMatchObject({ code: 'provider_unavailable' });
    expect(fake.calls).toHaveLength(2);
  });

  it('non-2xx, malformed JSON, a failed connection and a hung one all surface as provider_unavailable', async () => {
    const bad = new FakePlateRecognizer(); bad.status = 403;
    await expect(new PlateRecognizerProvider(bad.fetch, { token: 't' }, noSleep).readPlate({ bytes })).rejects.toMatchObject({ code: 'provider_unavailable' });
    const malformed = new FakePlateRecognizer(); malformed.raw = '<html>not json';
    await expect(new PlateRecognizerProvider(malformed.fetch, { token: 't' }, noSleep).readPlate({ bytes })).rejects.toMatchObject({ code: 'provider_unavailable' });
    const failed = new FakePlateRecognizer(); failed.fail = true;
    await expect(new PlateRecognizerProvider(failed.fetch, { token: 't' }, noSleep).readPlate({ bytes })).rejects.toMatchObject({ code: 'provider_unavailable' });
  });
});
