export class FakeResend {
  sent: Record<string, unknown>[] = [];
  fail = false;
  // m3 (final whole-branch review): defaults to a nameless/transient failure (no discriminator the
  // real SDK's RESEND_ERROR_CODE_KEY union would recognize) — matches the historical 'resend down'
  // fixture every existing transient-retry test relies on. Tests proving the NEW permanent-4xx
  // classification override this with a real error name (e.g. 'invalid_from_address').
  failError: { message: string; name?: string; statusCode?: number | null } = { message: 'resend down' };
  emails = {
    send: async (p: Record<string, unknown>) => {
      if (this.fail) return { data: null, error: this.failError };
      this.sent.push(p);
      return { data: { id: 're_1' }, error: null };
    },
  };
}
