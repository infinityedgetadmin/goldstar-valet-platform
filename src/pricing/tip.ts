export type TipChoice = { kind: 'preset'; percent: number } | { kind: 'custom'; amount: number } | { kind: 'none' };
/** `input.subtotal` should be the tax-inclusive total (PriceBreakdown.total): tip is computed on the tax-inclusive total. */
export function computeTip(input: { subtotal: number; choice: TipChoice; presets: number[] }): number {
  switch (input.choice.kind) {
    case 'none': return 0;
    case 'preset': return input.presets.includes(input.choice.percent) ? Math.round((input.subtotal * input.choice.percent) / 100) : 0;
    case 'custom': return Math.min(input.subtotal, Math.max(0, Math.round(input.choice.amount)));
  }
}
