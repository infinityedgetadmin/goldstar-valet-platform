export function nowIso(): string { return new Date().toISOString(); }
export function minutesBetween(a: Date, b: Date): number { return Math.max(0, Math.floor((b.getTime() - a.getTime()) / 60_000)); }
export function secondsBetween(a: Date, b: Date): number { return Math.max(0, Math.floor((b.getTime() - a.getTime()) / 1000)); }
