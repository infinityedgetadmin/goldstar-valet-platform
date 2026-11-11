import type { Guest } from '../../src/schemas/guest';
import type { Invitation } from '../../src/schemas/invitation';
import type { User } from '../../src/schemas/user';
import { emailFor, GUEST_NAME, GUEST_PHONE, GUEST_UID, OP, USERS, V_EVENT, V_HOTEL, V1 } from './constants';
import type { DemoClock } from './context';
import { demoSha256 } from './context';
import type { DemoAuthUser, SeedDoc } from './types';

interface StaffSpec {
  uid: string;
  displayName: string;
  roles: User['roles'];
  venueIds: string[];
  status?: User['status'];
  phone?: string;
  hourlyRate?: number;
  payoutStatus?: User['payoutStatus'];
  credentials?: User['credentials'];
  eligibility?: User['eligibility'];
  notificationPrefs?: User['notificationPrefs'];
  /** Base-seed accounts already exist in Auth; the demo layer only re-writes their user doc. */
  inBaseSeed: boolean;
}

const ALL_VENUES = [V1, V_HOTEL, V_EVENT];

function driverCredentials(clock: DemoClock, licenseExpiresInDays: number): NonNullable<User['credentials']> {
  return {
    licenseNumber: 'IN-4410-2287',
    licenseState: 'IN',
    licenseClass: 'D',
    endorsements: [],
    licenseExpiresAt: clock.daysAgo(-licenseExpiresInDays),
    insuranceCarrier: 'Progressive Commercial',
    insuranceExpiresAt: clock.daysAgo(-200),
    backgroundCheck: { status: 'approved', at: clock.daysAgo(120), provider: 'Checkr' },
    documents: [],
  };
}

function staffSpecs(clock: DemoClock): StaffSpec[] {
  return [
    { uid: USERS.owner1, displayName: 'Chris Kolditz', roles: ['owner'], venueIds: ALL_VENUES, inBaseSeed: true, phone: '+13175550100', notificationPrefs: { emailClaims: true, emailCredentials: true, pushRequests: false } },
    { uid: USERS.admin1, displayName: 'Dana Whitfield', roles: ['admin'], venueIds: ALL_VENUES, inBaseSeed: false },
    // Same roles/venueIds as the base seed's platform1 (its claim assertion expects exactly these).
    { uid: USERS.platform1, displayName: 'Platform Admin', roles: ['platform_admin'], venueIds: [], inBaseSeed: true },
    { uid: USERS.lead1, displayName: 'Marcus Reed', roles: ['lead'], venueIds: [V1, V_EVENT], inBaseSeed: true, hourlyRate: 2200, payoutStatus: 'active' },
    { uid: USERS.att1, displayName: 'Tyler Brooks', roles: ['attendant'], venueIds: [V1], inBaseSeed: true, hourlyRate: 1600, payoutStatus: 'active' },
    { uid: USERS.att2, displayName: 'Aaliyah Grant', roles: ['attendant'], venueIds: [V1, V_HOTEL], inBaseSeed: false, hourlyRate: 1600, payoutStatus: 'onboarding' },
    { uid: USERS.att3, displayName: 'Sam Ortiz', roles: ['attendant'], venueIds: [V_HOTEL], inBaseSeed: false, hourlyRate: 1600, payoutStatus: 'restricted' },
    {
      uid: USERS.primary1,
      displayName: 'Jamal Carter',
      roles: ['driver'],
      venueIds: [V1],
      inBaseSeed: true,
      hourlyRate: 2400,
      payoutStatus: 'active',
      credentials: driverCredentials(clock, 400),
      eligibility: { driveHome: true, passengerRide: true, reasons: [] },
    },
    {
      uid: USERS.chase1,
      displayName: 'Erin Walsh',
      roles: ['driver'],
      venueIds: [V1],
      inBaseSeed: true,
      hourlyRate: 2400,
      credentials: driverCredentials(clock, 500),
      eligibility: { driveHome: true, passengerRide: true, reasons: [] },
    },
    {
      // License expires in 12 days: drives the dashboard's credential warning and the staff
      // app's Shift-tab banner.
      uid: USERS.driver1,
      displayName: 'Luis Romero',
      roles: ['driver'],
      venueIds: [V1, V_HOTEL],
      inBaseSeed: false,
      hourlyRate: 2400,
      credentials: driverCredentials(clock, 12),
      eligibility: { driveHome: true, passengerRide: true, reasons: [] },
    },
    { uid: USERS.venue1, displayName: 'St. Elmo Host Stand', roles: ['venue_user'], venueIds: [V1], inBaseSeed: false },
    { uid: USERS.hotel1, displayName: 'Meridian Front Desk', roles: ['venue_user'], venueIds: [V_HOTEL], inBaseSeed: false },
    { uid: USERS.invited1, displayName: 'Priya Nair', roles: ['attendant'], venueIds: [V_EVENT], inBaseSeed: false, status: 'invited' },
    { uid: USERS.suspended1, displayName: 'Kevin Doyle', roles: ['attendant'], venueIds: [V1], inBaseSeed: false, status: 'suspended' },
  ];
}

function userDoc(clock: DemoClock, spec: StaffSpec): User {
  const status = spec.status ?? 'active';
  return {
    uid: spec.uid,
    operatorId: OP,
    displayName: spec.displayName,
    email: emailFor(spec.uid),
    ...(spec.phone ? { phone: spec.phone } : {}),
    roles: spec.roles,
    venueIds: spec.venueIds,
    status,
    ...(spec.credentials ? { credentials: spec.credentials } : {}),
    eligibility: spec.eligibility ?? { driveHome: false, passengerRide: false, reasons: [] },
    payoutStatus: spec.payoutStatus ?? 'none',
    fcmTokens: [],
    invitedAt: clock.daysAgo(90),
    ...(status === 'active' ? { activatedAt: clock.daysAgo(88), lastSeenAt: clock.minutesAgo(3) } : {}),
    ...(spec.hourlyRate !== undefined ? { hourlyRate: spec.hourlyRate } : {}),
    ...(spec.notificationPrefs ? { notificationPrefs: spec.notificationPrefs } : {}),
  };
}

export interface PeopleOutput {
  docs: SeedDoc[];
  authUsers: DemoAuthUser[];
}

export function buildPeople(clock: DemoClock): PeopleOutput {
  const specs = staffSpecs(clock);
  const docs: SeedDoc[] = specs.map((spec) => ({ kind: 'user', path: `operators/${OP}/users/${spec.uid}`, data: userDoc(clock, spec) }));

  // New staff get an Auth account; an invited user has none yet (they get one by accepting).
  const authUsers: DemoAuthUser[] = specs
    .filter((s) => !s.inBaseSeed && s.status !== 'invited')
    .map((s) => ({ uid: s.uid, email: emailFor(s.uid), displayName: s.displayName, operatorId: OP }));

  // The pending invitation behind the "invited" staff row. tokenHash is a fixed digest, so the
  // accept link only works in tests that know the matching token; the dashboard just lists it.
  const invitation: Invitation = {
    id: 'demo-invite-priya',
    email: emailFor(USERS.invited1),
    operatorId: OP,
    roles: ['attendant'],
    venueIds: [V_EVENT],
    displayName: 'Priya Nair',
    tokenHash: demoSha256(0xbeef),
    expiresAt: clock.daysAgo(-6),
    acceptedAt: null,
    invitedBy: USERS.owner1,
    createdAt: clock.daysAgo(1),
  };
  docs.push({ kind: 'invitation', path: `invitations/${invitation.id}`, data: invitation });

  // Phone-auth guest for the guest app: claims mirror what guestLinkPhone mints ({roles:['guest']});
  // the phone_number claim comes from the Auth emulator's phone sign-in itself.
  authUsers.push({ uid: GUEST_UID, phoneNumber: GUEST_PHONE, displayName: GUEST_NAME, claims: { roles: ['guest'] } });
  const guest: Guest = {
    phoneE164: GUEST_PHONE,
    name: GUEST_NAME,
    savedVehicles: [
      { plate: 'GLD2024', state: 'IN', make: 'BMW', model: 'X5', color: 'Black', label: 'Daily driver' },
      { plate: 'RVR88', state: 'IN', make: 'Land Rover', model: 'Defender', color: 'Green', label: 'Weekend' },
    ],
    savedAddresses: [
      { label: 'Home', address: '1100 N Delaware St, Indianapolis, IN 46202', geo: { lat: 39.7817, lng: -86.1548 } },
      { label: 'Office', address: '1 American Sq, Indianapolis, IN 46282', geo: { lat: 39.7686, lng: -86.1608 } },
    ],
    needs: { wheelchair: false, extraTime: true },
    fcmTokens: [],
    consent: { sms: true, push: true },
    lastOperatorId: OP,
    updatedAt: clock.daysAgo(2),
  };
  docs.push({ kind: 'guest', path: `guests/${GUEST_UID}`, data: guest });

  return { docs, authUsers };
}
