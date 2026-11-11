import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';

// Guard both the app and the Firestore settings() call against re-initialization: getApps() reflects
// admin-sdk-internal state that persists across module reloads (e.g. vitest resetting the module
// registry between test files in the same worker), so a second module evaluation would otherwise call
// settings() a second time on the same already-configured Firestore instance and throw.
const isNewApp = getApps().length === 0;
if (isNewApp) initializeApp();

export const adminDb = getFirestore();
if (isNewApp) adminDb.settings({ ignoreUndefinedProperties: true });
export const adminAuth = getAuth();
export const adminStorage = getStorage();
