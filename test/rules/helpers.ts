import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, setDoc, type Firestore } from 'firebase/firestore';
import { env } from './setup';
export { assertFails, assertSucceeds };
export interface Claims { operatorId?: string; roles: string[]; venueIds?: string[]; claimsVersion?: number; phone_number?: string }
export const ctx = (uid: string, claims: Claims) => env.authenticatedContext(uid, { ...claims, claimsVersion: claims.claimsVersion ?? 1 }).firestore();
export const anon = () => env.unauthenticatedContext().firestore();
export async function seed(fn: (db: Firestore) => Promise<void>) { await env.withSecurityRulesDisabled(async (c) => fn(c.firestore())); }
export const OP = 'goldstar'; export const OP2 = 'valetb'; export const V1 = 'v1'; export const V2 = 'v2';
export const TID = '01912345-7abc-7def-8123-456789abcdef'; export const EID = '01912345-7abc-7def-8123-456789abcde0'; export const TOKEN = 'AbCdEfGhIjKlMnOpQrStUv';
export const NOW = '2026-08-23T21:00:00.000Z';
export function baseTicket(over: Record<string, unknown> = {}) {
  return { id: TID, operatorId: OP, venueId: V1, jobType: 'valet', status: 'checked_in', source: 'staff', guest: { phoneE164: '+13175550123', phoneLast4: '0123', consentSms: true }, vehicle: { plate: 'ABC123', state: 'IN', make: 'Honda', model: 'Civic', color: 'Blue' }, keyTagId: 'k1', zoneId: 'A', flags: { assistance: false, accessibleVehicle: false, photosSkipped: false, vip: false }, attendants: { checkedInBy: 'att1' }, times: { checkedInAt: NOW }, damageReportIds: [], incidentIds: [], guestToken: TOKEN, ...over };
}
export async function seedTenant() {
  await seed(async (db) => {
    await setDoc(doc(db, `operators/${OP}`), { id: OP, name: 'Goldstar', slug: OP, status: 'active', timezone: 'America/Indiana/Indianapolis', currency: 'USD', isSandbox: false, plan: 'standard', branding: { displayName: 'Goldstar', primaryColor: '#ab6034', accentColor: '#ffc30c' }, modules: {}, features: {}, createdAt: NOW, updatedAt: NOW, createdBy: 'system' });
    await setDoc(doc(db, `operators/${OP2}`), { id: OP2, name: 'Valet B', slug: OP2, status: 'active', timezone: 'America/Chicago', currency: 'USD', isSandbox: false, plan: 'standard', branding: { displayName: 'Valet B', primaryColor: '#1d4ed8', accentColor: '#f59e0b' }, modules: {}, features: {}, createdAt: NOW, updatedAt: NOW, createdBy: 'system' });
    await setDoc(doc(db, `operators/${OP}/venues/${V1}`), { id: V1, operatorId: OP, name: 'St. Elmo', type: 'restaurant', status: 'active' });
    await setDoc(doc(db, `operators/${OP}/venues/${V2}`), { id: V2, operatorId: OP, name: 'Conrad', type: 'hotel', status: 'active' });
    await setDoc(doc(db, `operators/${OP}/users/att1`), { uid: 'att1', operatorId: OP, roles: ['attendant'], venueIds: [V1], status: 'active', eligibility: { driveHome: false, passengerRide: false, reasons: [] } });
    await setDoc(doc(db, `operators/${OP}/users/lead1`), { uid: 'lead1', operatorId: OP, roles: ['lead'], venueIds: [V1, V2], status: 'active' });
    await setDoc(doc(db, `operators/${OP}/users/drv1`), { uid: 'drv1', operatorId: OP, roles: ['attendant', 'driver'], venueIds: [V1], status: 'active', eligibility: { driveHome: true, passengerRide: true, reasons: [] } });
    await setDoc(doc(db, `operators/${OP}/users/drv2`), { uid: 'drv2', operatorId: OP, roles: ['attendant', 'driver'], venueIds: [V1], status: 'active', eligibility: { driveHome: true, passengerRide: true, reasons: [] } });
    await setDoc(doc(db, `operators/${OP}/users/att2`), { uid: 'att2', operatorId: OP, roles: ['attendant'], venueIds: [V2], status: 'active' });
    await setDoc(doc(db, `operators/${OP}/keyTags/k1`), { id: 'k1', operatorId: OP, value: 'GS-V1-0001', venueId: V1, status: 'available' });
  });
}
export const ATT = () => ctx('att1', { operatorId: OP, roles: ['attendant'], venueIds: [V1] });
export const ATT_V2 = () => ctx('att2', { operatorId: OP, roles: ['attendant'], venueIds: [V2] });
export const LEAD = () => ctx('lead1', { operatorId: OP, roles: ['lead'], venueIds: [V1, V2] });
export const ADMIN = () => ctx('adm1', { operatorId: OP, roles: ['admin'] });
export const OWNER = () => ctx('own1', { operatorId: OP, roles: ['owner'] });
export const DRIVER = () => ctx('drv1', { operatorId: OP, roles: ['attendant', 'driver'], venueIds: [V1] });
export const OTHER_OP = () => ctx('att9', { operatorId: OP2, roles: ['attendant', 'lead', 'admin', 'owner'], venueIds: [V1] });
export const PLATFORM = () => ctx('pa1', { roles: ['platform_admin'] });
export const VENUE_USER = () => ctx('host1', { operatorId: OP, roles: ['venue_user'], venueIds: [V1] });
export const GUEST = (phone = '+13175550123') => ctx('g1', { roles: ['guest'], phone_number: phone });
