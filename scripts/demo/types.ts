import type { AuditLogEntry } from '../../src/schemas/auditLogEntry';
import type { Claim } from '../../src/schemas/claim';
import type { DamageReport, Photo } from '../../src/schemas/damage';
import type { FleetVehicle } from '../../src/schemas/fleetVehicle';
import type { Guest } from '../../src/schemas/guest';
import type { HostRequest } from '../../src/schemas/hostRequest';
import type { Incident } from '../../src/schemas/incident';
import type { Integration } from '../../src/schemas/integration';
import type { KeyTag } from '../../src/schemas/keyTag';
import type { Invitation } from '../../src/schemas/invitation';
import type { Invoice } from '../../src/schemas/invoice';
import type { LiveLocation } from '../../src/schemas/liveLocation';
import type { MetricsDaily } from '../../src/schemas/metricsDaily';
import type { MetricsForecast } from '../../src/schemas/metricsForecast';
import type { Operator } from '../../src/schemas/operator';
import type { PayoutAllocation, PayoutBatch } from '../../src/schemas/payoutBatch';
import type { ClockEvent, Shift } from '../../src/schemas/shift';
import type { CustodyEvent, Ticket } from '../../src/schemas/ticket';
import type { Transaction } from '../../src/schemas/transaction';
import type { User } from '../../src/schemas/user';
import type { Validation } from '../../src/schemas/validation';
import type { Venue } from '../../src/schemas/venue';

/**
 * One Firestore document in the demo dataset. `kind` names the @goldstar/platform schema the
 * document must satisfy; dataset.test.ts parses every document against it, so a demo document can
 * never drift from what the apps and rules expect.
 */
export type SeedDoc =
  | { kind: 'operator'; path: string; data: Operator }
  | { kind: 'venue'; path: string; data: Venue }
  | { kind: 'user'; path: string; data: User }
  | { kind: 'ticket'; path: string; data: Ticket }
  | { kind: 'custodyEvent'; path: string; data: CustodyEvent }
  | { kind: 'keyTag'; path: string; data: KeyTag }
  | { kind: 'damageReport'; path: string; data: DamageReport }
  | { kind: 'photo'; path: string; data: Photo }
  | { kind: 'transaction'; path: string; data: Transaction }
  | { kind: 'liveLocation'; path: string; data: LiveLocation }
  | { kind: 'shift'; path: string; data: Shift }
  | { kind: 'clockEvent'; path: string; data: ClockEvent }
  | { kind: 'fleetVehicle'; path: string; data: FleetVehicle }
  | { kind: 'incident'; path: string; data: Incident }
  | { kind: 'claim'; path: string; data: Claim }
  | { kind: 'validation'; path: string; data: Validation }
  | { kind: 'hostRequest'; path: string; data: HostRequest }
  | { kind: 'invoice'; path: string; data: Invoice }
  | { kind: 'payoutBatch'; path: string; data: PayoutBatch }
  | { kind: 'payoutAllocation'; path: string; data: PayoutAllocation }
  | { kind: 'integration'; path: string; data: Integration }
  | { kind: 'auditLogEntry'; path: string; data: AuditLogEntry }
  | { kind: 'invitation'; path: string; data: Invitation }
  | { kind: 'guest'; path: string; data: Guest }
  | { kind: 'metricsDaily'; path: string; data: MetricsDaily }
  | { kind: 'metricsForecast'; path: string; data: MetricsForecast };

export type SeedDocKind = SeedDoc['kind'];

/** An Auth emulator account. `claims` are written directly (see seed-demo.ts for why). */
export interface DemoAuthUser {
  uid: string;
  email?: string;
  phoneNumber?: string;
  displayName: string;
  /** Present for operator staff; the writer mints claims through syncClaimsHandler instead. */
  operatorId?: string;
  /** Only for non-staff accounts (the phone guest), whose claims no handler mints at seed time. */
  claims?: Record<string, unknown>;
}

/** A Storage emulator object: `source` is a file under scripts/demo/photos/. */
export interface DemoStorageObject {
  path: string;
  source: string;
  contentType: 'image/jpeg';
}

export interface DemoDataset {
  docs: SeedDoc[];
  authUsers: DemoAuthUser[];
  storage: DemoStorageObject[];
  /** Ticket paths whose status the writer re-reads after triggers settle (see seed-demo.ts). */
  expectedTicketStatuses: Record<string, string>;
}
