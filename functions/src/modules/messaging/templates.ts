const DEFAULTS: Record<string, string> = {
  welcome: '{{operator}} at {{venue}}: your car is checked in. Tap to request it, pay, or tip: {{link}} Reply STOP to opt out.',
  ready: 'Your car is ready at the {{venue}} valet stand. {{link}}',
  survey: 'Thanks for visiting {{venue}}. How did we do? {{link}}#survey',
  driveHomeAssigned: 'Your {{operator}} driver is on the way. Track here: {{link}}',
  rideAssigned: 'Your ride is on the way. Track here: {{link}}',
  receipt: 'Your {{operator}} receipt: {{link}}#receipt',
};

export function renderTemplate(name: string, vars: Record<string, unknown>, venueSms: Record<string, string | undefined>): string {
  const tpl = venueSms[name] ?? DEFAULTS[name] ?? '{{link}}';
  return tpl
    .replace(/\{\{(\w+)\}\}/g, (_, k: string) => {
      const v = vars[k];
      // vars is Record<string, unknown> — only stringify values with a meaningful toString
      // (primitives); anything else (object, undefined, ...) renders as empty rather than risking
      // '[object Object]' leaking into a guest-facing SMS.
      return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';
    })
    .slice(0, 320);
}
