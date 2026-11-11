export interface QuerySpec { collection?: string; collectionGroup?: string; fields: readonly string[]; desc?: string; arrayContains?: string }
/** Every client query must be registered here; Plan 1b generates firestore.indexes.json from this table. */
export const QUERIES = {
  venueQueue: { collection: 'tickets', fields: ['venueId', 'status', 'times.requestedAt'] as const },
  venueRecent: { collection: 'tickets', fields: ['venueId', 'times.checkedInAt'] as const, desc: 'times.checkedInAt' },
  myClaimed: { collection: 'tickets', fields: ['attendants.claimedBy', 'status'] as const },
  guestHistory: { collection: 'tickets', fields: ['guest.uid', 'times.checkedInAt'] as const, desc: 'times.checkedInAt' },
  // Fix round 4 (task-platform-report.md, Plan 6): the guest MOBILE app's live "my tickets" list
  // (goldstar-mobile's use-my-tickets.ts) queries ACROSS every operator by uid —
  // `collectionGroup('tickets').where('guest.uid','==',uid).orderBy('times.checkedInAt','desc')` —
  // a genuinely different query from `guestHistory` above, which is `collection`-scoped (one
  // operator's tickets subcollection; staff-facing per-operator history, not this cross-operator
  // guest-facing one). Unlike the Admin-SDK-only collectionGroup indexes hand-added directly to
  // firestore.indexes.json elsewhere (identity/eligibility.ts's users.status,
  // guest/ticketsByGuest.ts's guest.uid, guest/emailReceipt.ts's id — none of which any CLIENT
  // ever issues), THIS one is a real client query, so it belongs here like every other one
  // (this file's own doc comment: "Every client query must be registered here").
  guestTicketsByUidOrdered: { collectionGroup: 'tickets', fields: ['guest.uid', 'times.checkedInAt'] as const, desc: 'times.checkedInAt' },
  venueShifts: { collection: 'shifts', fields: ['venueId', 'date'] as const },
  myShifts: { collection: 'shifts', fields: ['assignedUids', 'date'] as const, arrayContains: 'assignedUids' },
  // Fix round 6 (task-platform-report.md, Plan 6 T3/T4): found by the new mobile-side QUERIES
  // guard — a REAL pre-existing production gap in the STAFF app, predating Plan 6 entirely.
  // goldstar-mobile's use-my-shift.ts queries ONE specific shift's clockEvents subcollection —
  // `query(opCol(operatorId, \`shifts/${shift.id}/clockEvents\`), where('uid','==',uid),
  // orderBy('at','desc'), limit(1))` — a `collection`-scope query (one shift's subcollection at a
  // time), NOT a `collectionGroup` one (unlike `myCustody`/`myPhotos` above, which deliberately
  // span EVERY parent — "my custody events across every ticket I've touched"). Same shape as
  // every other `collection`-scoped entry here: the `collection` field names the collection ID
  // only (not the full nested path), and a COLLECTION-scope index applies to every collection
  // instance with that ID regardless of nesting depth or which operator/shift it's under — no new
  // registry concept needed, this slots in exactly like `venueShifts`/`reportsByTicket` above.
  clockEventsByUid: { collection: 'clockEvents', fields: ['uid', 'at'] as const, desc: 'at' },
  venueKeyTags: { collection: 'keyTags', fields: ['venueId', 'status'] as const },
  // Plan 2b (contracts v0.3.5, finding 14): equality-only (venueId ==, value ==) — served by
  // Firestore's automatic single-field index merging, no composite index required. Registered
  // here for registry completeness (every client query listed), not because it needs an entry
  // in firestore.indexes.json.
  keyTagByValue: { collection: 'keyTags', fields: ['venueId', 'value'] as const },
  myCustody: { collectionGroup: 'custodyEvents', fields: ['actorUid', 'at'] as const, desc: 'at' },
  myPhotos: { collectionGroup: 'photos', fields: ['actorUid', 'at'] as const, desc: 'at' },
  venueParked: { collection: 'tickets', fields: ['venueId', 'status', 'times.checkedInAt'] as const, desc: 'times.checkedInAt' },
  reportsByTicket: { collection: 'damageReports', fields: ['ticketId', 'createdAt'] as const, desc: 'createdAt' },
  guestByPhone: { collectionGroup: 'tickets', fields: ['guest.phoneE164', 'status'] as const },
  archiveClosed: { collectionGroup: 'tickets', fields: ['status', 'times.closedAt'] as const },
  archiveCancelled: { collectionGroup: 'tickets', fields: ['status', 'times.cancelledAt'] as const },
  auditByAction: { collection: 'auditLog', fields: ['action', 'at'] as const, desc: 'at' },
  auditByActor: { collection: 'auditLog', fields: ['actorUid', 'at'] as const, desc: 'at' },
  outboundRetry: { collection: 'outboundMessages', fields: ['status', 'retryAt'] as const },
  myPrimaryJobs: { collection: 'tickets', fields: ['attendants.primaryDriverUid', 'status'] as const },
  myChaseJobs: { collection: 'tickets', fields: ['attendants.chaseDriverUid', 'status'] as const },
  jobsActive: { collection: 'tickets', fields: ['jobType', 'status', 'times.assignedAt'] as const },
  platesByOperator: { collection: 'tickets', fields: ['vehicle.plate', 'times.checkedInAt'] as const, desc: 'times.checkedInAt' },
  validationsByCode: { collection: 'validations', fields: ['venueId', 'code'] as const },
  // The venue portal's validations panel (Plan 7 T1b) currently runs a LONE `venueId` equality and
  // sorts client-side, because no `[venueId, issuedAt]` shape was registered — and an unregistered
  // composite would have passed every local gate (the emulator does not enforce composite indexes)
  // and failed only in production, the `guestTicketsByUidOrdered` lesson. This entry is what lets
  // that panel order and `limit` server-side instead of growing unbounded as history accumulates.
  validationsByVenue: { collection: 'validations', fields: ['venueId', 'issuedAt'] as const, desc: 'issuedAt' },
  hostRequestsOpen: { collection: 'hostRequests', fields: ['venueId', 'status', 'at'] as const },
  transactionsByVenue: { collection: 'transactions', fields: ['venueId', 'at'] as const, desc: 'at' },
  invoicesByVenue: { collection: 'invoices', fields: ['venueId', 'period'] as const },
  guestsByPhone: { collection: 'guests', fields: ['phoneE164'] as const },
  refundRetry: { collectionGroup: 'tickets', fields: ['payment.refundRequested', 'payment.refundRetryAt'] as const },
  refundReclaim: { collectionGroup: 'tickets', fields: ['payment.refundInProgress', 'payment.refundClaimedAt'] as const },
  outboundStaleLease: { collection: 'outboundMessages', fields: ['status', 'leaseUntil'] as const },
} as const satisfies Record<string, QuerySpec>;
