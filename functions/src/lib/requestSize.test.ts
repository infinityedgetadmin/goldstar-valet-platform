import { describe, expect, it, vi } from 'vitest';
import { MAX_REQUEST_BYTES, rejectOversized } from './requestSize.js';

function req(over: { contentLength?: string; rawBody?: Buffer }) {
  return {
    get: (h: string) => (h.toLowerCase() === 'content-length' ? over.contentLength : undefined),
    rawBody: over.rawBody,
  };
}
function res() {
  const send = vi.fn();
  const status = vi.fn(() => ({ send }));
  return { status, send };
}

describe('rejectOversized (Plan 8 Task 16)', () => {
  it('passes a small body with a matching Content-Length', () => {
    const r = res();
    expect(rejectOversized(req({ contentLength: '120', rawBody: Buffer.alloc(120) }), r)).toBe(false);
    expect(r.status).not.toHaveBeenCalled();
  });

  it('exactly the limit is allowed; one byte over is a 413 — by declared length OR by actual body', () => {
    const at = res();
    expect(rejectOversized(req({ contentLength: String(MAX_REQUEST_BYTES), rawBody: Buffer.alloc(MAX_REQUEST_BYTES) }), at)).toBe(false);

    const declared = res();
    expect(rejectOversized(req({ contentLength: String(MAX_REQUEST_BYTES + 1), rawBody: Buffer.alloc(10) }), declared)).toBe(true);
    expect(declared.status).toHaveBeenCalledWith(413);
    expect(declared.send).toHaveBeenCalledWith('payload too large');

    const actual = res();
    expect(rejectOversized(req({ contentLength: '10', rawBody: Buffer.alloc(MAX_REQUEST_BYTES + 1) }), actual)).toBe(true);
    expect(actual.status).toHaveBeenCalledWith(413);
  });

  it('a missing or non-numeric Content-Length falls back to the buffered body alone', () => {
    const r = res();
    expect(rejectOversized(req({ rawBody: Buffer.alloc(5) }), r)).toBe(false);
    expect(rejectOversized(req({ contentLength: 'abc', rawBody: Buffer.alloc(5) }), r)).toBe(false);
    expect(rejectOversized(req({ contentLength: 'abc', rawBody: Buffer.alloc(MAX_REQUEST_BYTES + 1) }), r)).toBe(true);
  });

  it('no body at all (a bare GET probe) is not oversized', () => {
    const r = res();
    expect(rejectOversized(req({}), r)).toBe(false);
  });

  it('honours a caller-supplied ceiling', () => {
    const r = res();
    expect(rejectOversized(req({ rawBody: Buffer.alloc(11) }), r, 10)).toBe(true);
  });
});
