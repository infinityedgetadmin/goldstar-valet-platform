export class FakeTwilio {
  sent: Record<string, unknown>[] = [];
  fail = false;
  messages = {
    create: async (p: Record<string, unknown>) => {
      if (this.fail) throw new Error('twilio down');
      this.sent.push(p);
      return { sid: 'SM1', status: 'queued' };
    },
  };
}
