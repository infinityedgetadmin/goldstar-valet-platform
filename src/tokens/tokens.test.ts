import { describe, expect, it } from 'vitest';
import { brand, generateScale, operatorTheme, cssVariables, typeScale, tailwindPreset } from './index';
describe('tokens', () => {
  it('Goldstar brand scale matches the web design system', () => {
    expect(brand[500]).toBe('#ab6034'); expect(brand[50]).toBe('#fdf8f5'); expect(brand[900]).toBe('#4a2515');
  });
  it('generateScale returns the input at 500 and lighter/darker stops', () => {
    const s = generateScale('#2563eb');
    expect(s[500]).toBe('#2563eb'); expect(Object.keys(s)).toHaveLength(11);
    const lum = (h: string) => { const n = parseInt(h.slice(1), 16); const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!; };
    expect(lum(s[50])).toBeGreaterThan(lum(s[900]));
  });
  it('operatorTheme regenerates only primary/accent', () => {
    const t = operatorTheme({ primaryColor: '#1d4ed8', accentColor: '#f59e0b' });
    expect(t.primary[500]).toBe('#1d4ed8'); expect(t.text.primary).toBe('#0a0807');
  });
  it('cssVariables emits --color-primary-500 etc.', () => {
    const v = cssVariables(operatorTheme({ primaryColor: '#ab6034', accentColor: '#ffc30c' }));
    expect(v['--color-primary-500']).toBe('#ab6034'); expect(v['--color-text-primary']).toBe('#0a0807');
  });
  it('type scale and preset', () => {
    expect(typeScale['display-2xl']).toEqual({ fontSize: 72, lineHeight: 1.1, letterSpacing: -0.02, fontWeight: 700 });
    expect(tailwindPreset.theme.extend.colors).toBeDefined();
  });
});
