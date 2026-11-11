import type { Role } from '@goldstar/platform';
import type { Deps } from '../../lib/deps.js';

export interface ExternalShift {
  externalId: string;
  venueId: string;
  date: string;
  startsAt: string;
  endsAt: string;
  leadEmail?: string;
  assignments: { email?: string; externalUserId?: string; role: Role }[];
  notes?: string;
}

export interface SyncResult {
  upserted: number;
  errors: string[];
  shifts: ExternalShift[];
}

export interface ProviderContext {
  deps: Deps;
  operatorId: string;
  config: Record<string, unknown>;
  secret: (name: string) => string;
}

export interface ScheduleProvider {
  kind: string;
  sync(ctx: ProviderContext, range: { from: string; to: string }): Promise<SyncResult>;
  handleWebhook?(ctx: ProviderContext, raw: { headers: Record<string, string>; body: unknown }): Promise<SyncResult>;
  pushClockEvent?(ctx: ProviderContext, e: { shiftExternalId: string; uid: string; externalUserId?: string; type: string; at: string }): Promise<void>;
  healthCheck(ctx: ProviderContext): Promise<{ ok: boolean; message?: string }>;
}

/**
 * Ruling AQ(b): a provider's `pushClockEvent` throws THIS specific class for a failure that will
 * never succeed on retry (bad credentials, malformed request, an unmapped user) — distinct from
 * a transient failure (network, 5xx, rate-limit), which should propagate as an ordinary `Error`
 * so `onClockEventCreated`'s own `retry: true` configuration retries the invocation. The trigger
 * catches this class specifically to decide NOT to let the error propagate (avoiding a retry
 * that can only ever fail the same way and delay the operator finding out), while still writing
 * to the integration doc's `lastError`/`health` either way.
 */
export class PermanentPushError extends Error {}
