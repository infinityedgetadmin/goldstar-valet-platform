export { onTicketWritten } from './onTicketWritten.js';
export { archiveClosedTickets } from './archive.js';
export { sweepEphemera } from './sweepLiveLocations.js';
// `onPhotoCreated` (the `photoCount` increment) was DELETED in Plan 8 Task 6 (carry #20/#25):
// the inspection gate now count()s the photos subcollection directly and nothing else read the
// field — platform, mobile, and dashboard all grepped. Old report docs keep a stale `photoCount`;
// the schema field stays (optional) until the next contracts bump window. `lastPhotoAt` had zero
// readers anywhere. Removing this export removes the deployed Function via CI/CD.
export { staffCancelTicket } from './staffCancel.js';
export { ticketsSearch } from './search.js';
export { ticketsRevealPhone } from './revealPhone.js';
