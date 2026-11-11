export { syncAllOperators, schedulingSyncNow, syncOperator } from './sync.js';
export { registerScheduleProvider, getScheduleProvider } from './registry.js';
export type { ScheduleProvider, ExternalShift, SyncResult, ProviderContext } from './port.js';
export { PermanentPushError } from './port.js';
export { onShiftWritten, computeClockedHours, computeTipPoolAllocations, tipPoolHandler } from './tipPool.js';
export type { ShiftWriteEvent } from './tipPool.js';
export { shiftsCorrectClock, correctClockHandler } from './correctClock.js';
export { onClockEventCreated, pushClockEventHandler } from './pushClock.js';
export type { ClockEventCreateEvent } from './pushClock.js';
export { ICalScheduleProvider } from './ical.adapter.js';
export { WhenIWorkScheduleProvider, mapWiwShifts, type WiwRawShift } from './wheniwork.adapter.js';

// Plan 7 Task 4 — external `ScheduleProvider` registration (registry.ts's own comment: "external
// adapters ... register themselves against this port from outside this module"). Side-effect
// registration here, not inside registry.ts itself, so registry.ts stays provider-agnostic and
// this module barrel — already re-exported from functions/src/index.ts — is what guarantees both
// adapters are registered at deploy time, the same way `internal` is registered inline in
// registry.ts's own provider map.
import { registerScheduleProvider } from './registry.js';
import { ICalScheduleProvider } from './ical.adapter.js';
import { WhenIWorkScheduleProvider } from './wheniwork.adapter.js';
registerScheduleProvider('ical', () => new ICalScheduleProvider());
registerScheduleProvider('when_i_work', () => new WhenIWorkScheduleProvider());
