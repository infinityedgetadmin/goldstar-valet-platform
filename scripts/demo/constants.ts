/**
 * Fixed identifiers for the owner-demo dataset. Base-seed ids (OP, V1, att1, lead1, owner1,
 * platform1, primary1, chase1, valetb) are repeated here rather than imported from
 * functions/test/helpers so these pure builders stay importable without initialising Firebase
 * Admin (helpers.ts pulls in functions/src/lib/app.ts, which calls initializeApp()).
 */

export const DEMO_TIMEZONE = 'America/Indiana/Indianapolis';

/** Same emulator-only test password as seed-emulator.ts (its `PASSWORD`). Never a real secret. */
export const DEMO_PASSWORD = 'password123';

/**
 * The base seed's walk-up ticket names only its make ("Ford", all the Maestro flow needs). The
 * demo fills in the rest when it re-times base tickets, so the queue and dashboard show a real
 * car instead of a bare "Ford" with no plate.
 */
export const BASE_WALKUP_VEHICLE = { make: 'Ford', model: 'Explorer', color: 'Blue', plate: 'FRD314', state: 'IN' } as const;

export const OP = 'goldstar';
export const OP_B = 'valetb';
/** A third tenant, suspended, so the platform console shows that state. */
export const OP_SUSPENDED = 'circlecity';
/** A fourth tenant mid-onboarding. */
export const OP_ONBOARDING = 'northside';

/** Base-seed restaurant (St. Elmo, zone A). */
export const V1 = 'v1';
/** Demo hotel: OPERA PMS configured, so the hotel portal, room charge and overnight report show. */
export const V_HOTEL = 'v-hotel';
/** Demo event venue: flat rate + static checkout enabled, so /pay/<venueToken> has a page. */
export const V_EVENT = 'v-event';
export const VB1 = 'vb1';

export const USERS = {
  // Base seed (seed-emulator.ts) personas, enriched by the demo layer.
  att1: 'att1',
  lead1: 'lead1',
  owner1: 'owner1',
  platform1: 'platform1',
  primary1: 'primary1',
  chase1: 'chase1',
  // Demo-only personas.
  admin1: 'admin1',
  att2: 'att2',
  att3: 'att3',
  driver1: 'driver1',
  venue1: 'venue1',
  hotel1: 'hotel1',
  invited1: 'invited1',
  suspended1: 'suspended1',
} as const;

export type DemoUid = (typeof USERS)[keyof typeof USERS];

export const emailFor = (uid: string): string => `${uid}@goldstar.example.com`;

/** Fleet vehicles: chase cars for drive-home, sedans/vans for passenger rides. */
export const FLEET = {
  chaseSedan: 'fleet-chase-sedan',
  chaseSuv: 'fleet-chase-suv',
  rideSedan: 'fleet-ride-sedan',
  rideVan: 'fleet-ride-van',
  maintenance: 'fleet-maint-sedan',
  retired: 'fleet-retired-van',
} as const;

/** Shifts referenced by tickets (`ticket.shiftId`) and by the shift/staffing screens. */
export const SHIFTS = {
  stElmoToday: 'shift-v1-today',
  hotelToday: 'shift-hotel-today',
  stElmoYesterday: 'shift-v1-yesterday',
  stElmoTomorrow: 'shift-v1-tomorrow',
  eventSaturday: 'shift-event-next',
} as const;

/** Phone-auth guest for the guest app (Auth emulator phone user + /guests doc + linked tickets). */
export const GUEST_UID = 'guest1';
export const GUEST_PHONE = '+13175550188';
export const GUEST_NAME = 'Jordan Ellis';
