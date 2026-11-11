export const P = {
  operator: (op: string) => `operators/${op}`,
  venue: (op: string, v: string) => `operators/${op}/venues/${v}`,
  user: (op: string, uid: string) => `operators/${op}/users/${uid}`,
  ticket: (op: string, id: string) => `operators/${op}/tickets/${id}`,
  custody: (op: string, id: string, ev: string) => `operators/${op}/tickets/${id}/custodyEvents/${ev}`,
  damage: (op: string, id: string) => `operators/${op}/damageReports/${id}`,
  claim: (op: string, id: string) => `operators/${op}/claims/${id}`,
  photo: (op: string, r: string, p: string) => `operators/${op}/damageReports/${r}/photos/${p}`,
  shift: (op: string, id: string) => `operators/${op}/shifts/${id}`,
  keyTag: (op: string, id: string) => `operators/${op}/keyTags/${id}`,
  fleetVehicle: (op: string, id: string) => `operators/${op}/fleetVehicles/${id}`,
  tx: (op: string, id: string) => `operators/${op}/transactions/${id}`,
  audit: (op: string | undefined, id: string) => (op ? `operators/${op}/auditLog/${id}` : `platform/auditLog/entries/${id}`),
  // Ruling C: `operators/{op}/archive/tickets/{id}` is a 5-segment (invalid) doc path.
  // Archived tickets live at a 4-segment doc `operators/{op}/archive/tickets_{id}`,
  // with archived subcollections nesting beneath it, e.g. `.../archive/tickets_{id}/custodyEvents/{ev}`.
  archiveTicket: (op: string, id: string) => `operators/${op}/archive/tickets_${id}`,
  guestTicket: (token: string) => `guestTickets/${token}`,
  venuePublic: (venueToken: string) => `venuePublic/${venueToken}`,
  guest: (uid: string) => `guests/${uid}`,
  invitation: (id: string) => `invitations/${id}`,
  outbound: (id: string) => `outboundMessages/${id}`,
  processed: (provider: string, id: string) => `processedEvents/${provider}_${id}`,
  liveLocation: (op: string, uid: string) => `operators/${op}/liveLocations/${uid}`,
  validation: (op: string, id: string) => `operators/${op}/validations/${id}`,
  hostRequest: (op: string, id: string) => `operators/${op}/hostRequests/${id}`,
  // Top-level, Functions-only (firestore.rules `match /surveys/{id}` denies all client access) —
  // carries operatorId/venueId fields rather than nesting, mirroring guests/guestTickets.
  survey: (id: string) => `surveys/${id}`,
  integration: (op: string, p: string) => `operators/${op}/integrations/${p}`,
  metricsDay: (op: string, day: string) => `operators/${op}/metrics/daily/days/${day}`,
  // Plan 8 Task 5 (carry #4): a Functions-only marker written by applyEvent.ts in the SAME
  // transaction as a refund, naming the charge row so the hourly sweep can revisit the day the
  // money was taken — id = the transaction id, so one row yields one marker no matter how many
  // refunds land on it.
  metricsRecompute: (op: string, txId: string) => `operators/${op}/metricsRecompute/${txId}`,
  // Plan 4b Task 7 — matches `firestore.rules`' pre-existing `metrics/forecast/weeks/{week}` read
  // rule (commented "Plan 4b T7 forecasting") exactly.
  metricsForecastWeek: (op: string, isoWeek: string) => `operators/${op}/metrics/forecast/weeks/${isoWeek}`,
  clockEvent: (op: string, shiftId: string, id: string) => `operators/${op}/shifts/${shiftId}/clockEvents/${id}`,
  payout: (op: string, uid: string, id: string) => `operators/${op}/users/${uid}/payouts/${id}`,
  invoice: (op: string, id: string) => `operators/${op}/invoices/${id}`,
  integrationToken: (op: string, p: string) => `operators/${op}/integrationTokens/${p}`,
  payoutBatch: (op: string, id: string) => `operators/${op}/payoutBatches/${id}`,
};
