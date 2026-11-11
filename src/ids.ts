let lastMs = 0;
let seq = 0;

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

/** RFC 9562 UUIDv7: 48-bit unix ms, 12-bit monotonic sequence, 62 random bits. */
export function uuidv7(): string {
  let ms = Date.now();
  if (ms === lastMs) { seq = (seq + 1) & 0xfff; if (seq === 0) ms = ++lastMs; }
  else { lastMs = ms; seq = randomBytes(2)[0]! & 0x7ff; }
  const r = randomBytes(8);
  const b = new Uint8Array(16);
  b[0] = (ms / 2 ** 40) & 0xff; b[1] = (ms / 2 ** 32) & 0xff; b[2] = (ms / 2 ** 24) & 0xff;
  b[3] = (ms / 2 ** 16) & 0xff; b[4] = (ms / 2 ** 8) & 0xff; b[5] = ms & 0xff;
  b[6] = 0x70 | (seq >> 8); b[7] = seq & 0xff;
  b[8] = 0x80 | (r[0]! & 0x3f);
  for (let i = 1; i < 8; i++) b[8 + i] = r[i]!;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function isUuid(s: string): boolean { return UUID_RE.test(s); }

/** 128-bit random token, base64url without padding (22 chars). Used for guestTickets keys. */
export function secretToken(): string {
  const bytes = randomBytes(16);
  let bin = '';
  for (const x of bytes) bin += String.fromCharCode(x);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
