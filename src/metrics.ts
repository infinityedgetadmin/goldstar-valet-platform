export const METRIC_DEFINITIONS = [
  { key: 'retrievalP50', label: 'Retrieval time (p50)', unit: 'sec' }, { key: 'retrievalP90', label: 'Retrieval time (p90)', unit: 'sec' },
  { key: 'tickets', label: 'Vehicles', unit: 'count' }, { key: 'throughputPerAttendantHour', label: 'Vehicles / attendant-hour', unit: 'ratio' },
  { key: 'tipRate', label: 'Digital tip rate', unit: 'percent' }, { key: 'avgTip', label: 'Average tip', unit: 'money' }, { key: 'tips', label: 'Tips', unit: 'money' }, { key: 'revenue', label: 'Revenue', unit: 'money' },
  { key: 'damageReports', label: 'Damage reports', unit: 'count' }, { key: 'claimsPer1000', label: 'Claims per 1,000 vehicles', unit: 'ratio' }, { key: 'laborCostPerVehicle', label: 'Labor cost / vehicle', unit: 'money' },
  { key: 'driveHomeJobs', label: 'Drive-home jobs', unit: 'count' }, { key: 'driveHomeCompletionSec', label: 'Drive-home completion', unit: 'sec' }, { key: 'chaseUtilization', label: 'Chase utilization', unit: 'percent' }, { key: 'rides', label: 'Passenger rides', unit: 'count' },
  { key: 'credentialCompliance', label: 'Credential compliance', unit: 'percent' }, { key: 'offlineSyncSuccess', label: 'Offline sync success', unit: 'percent' },
] as const;
export type MetricKey = (typeof METRIC_DEFINITIONS)[number]['key'];
export function percentile(values: number[], p: number): number | null { if (values.length === 0) return null; const s = [...values].sort((a, b) => a - b); const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1)); return s[idx]!; }
