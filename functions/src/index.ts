import { setGlobalOptions } from 'firebase-functions/v2';

setGlobalOptions({ region: 'us-central1', maxInstances: 20 });

export * from './modules/identity/index.js';
export * from './modules/platform/index.js';
export * from './modules/tickets/index.js';
export * from './modules/incidents/index.js';
export * from './modules/guest/index.js';
export * from './modules/audit/index.js';
export * from './modules/payments/index.js';
export * from './modules/messaging/index.js';
export * from './modules/notifications/index.js';
export * from './modules/scheduling/index.js';
export * from './modules/maps/index.js';
export * from './modules/vision/index.js';
export * from './modules/integrations/index.js';
export * from './modules/venues/index.js';
export * from './modules/venue/index.js';
export * from './modules/pos/index.js';
export * from './modules/pms/index.js';
export * from './modules/accounting/index.js';
export * from './modules/claims/index.js';
export * from './modules/analytics/index.js';
export * from './modules/dispatch/index.js';
