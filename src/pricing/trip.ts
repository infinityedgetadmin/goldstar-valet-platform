import type { Quote } from '../schemas/ticket';
import type { z } from 'zod';
import type { tripRatesSchema } from '../schemas/venue';
export type TripRates = z.infer<typeof tripRatesSchema>;
const METERS_PER_MILE = 1609.344;
export function computeTripQuote(input: { rates: TripRates; distanceMeters: number; durationSec: number }): Quote {
  const miles = input.distanceMeters / METERS_PER_MILE;
  const minutes = input.durationSec / 60;
  const distance = Math.round(miles * input.rates.perMile);
  const time = Math.round(minutes * input.rates.perMinute);
  const raw = input.rates.base + distance + time;
  const amount = Math.max(raw, input.rates.minimum);
  const breakdown = [{ label: 'Base', amount: input.rates.base }, { label: 'Distance', amount: distance }, { label: 'Time', amount: time }];
  if (amount > raw) breakdown.push({ label: 'Minimum fare adjustment', amount: amount - raw });
  return { base: input.rates.base, distanceMeters: input.distanceMeters, durationSec: input.durationSec, amount, breakdown };
}
