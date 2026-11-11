import type { ScheduleProvider } from './port.js';
import { InternalScheduleProvider } from './internal.adapter.js';

// Map-based registry (rather than the switch-on-operator-config pattern used by
// getGateway/getMessaging) because external adapters (ICal, WhenIWork — Plan 7) register
// themselves against this port from outside this module; the registry has to accept
// providers it doesn't know about at authoring time.
const providers = new Map<string, () => ScheduleProvider>([['internal', () => new InternalScheduleProvider()]]);

export function registerScheduleProvider(kind: string, factory: () => ScheduleProvider) {
  providers.set(kind, factory);
}

export function getScheduleProvider(kind: string): ScheduleProvider {
  const f = providers.get(kind);
  if (!f) throw new Error(`no schedule provider ${kind}`);
  return f();
}
