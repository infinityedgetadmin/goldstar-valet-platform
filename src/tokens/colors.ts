import { generateScale, type ColorScale } from './scale';

export const brand: ColorScale = {
  50: '#fdf8f5',
  100: '#f9ede4',
  200: '#f0d5c4',
  300: '#e5b89c',
  400: '#d89268',
  500: '#ab6034',
  600: '#954f2a',
  700: '#7a3f22',
  800: '#5f311b',
  900: '#4a2515',
  DEFAULT: '#ab6034',
};
export const accent = generateScale('#ffc30c');
export const text = { primary: '#0a0807', secondary: '#696969', tertiary: '#8a8a8a', disabled: '#b3b3b3', inverse: '#ffffff' } as const;
export const surface = { primary: '#ffffff', secondary: '#f4f2f1', tertiary: '#fafafa', dark: '#0c0b0b', overlay: 'rgba(0,0,0,0.7)' } as const;
export const border = { DEFAULT: '#d9dfe7', light: '#e5e7eb', dark: '#374151', focus: '#ab6034' } as const;
export const semantic = {
  success: { 50: '#f0fdf4', 100: '#dcfce7', 500: '#22c55e', 600: '#16a34a', 700: '#15803d' },
  error: { 50: '#fef2f2', 100: '#fee2e2', 500: '#ef4444', 600: '#dc2626', 700: '#b91c1c' },
  warning: { 50: '#fffbeb', 100: '#fef3c7', 500: '#f59e0b', 600: '#d97706', 700: '#b45309' },
  info: { 50: '#eff6ff', 100: '#dbeafe', 500: '#3b82f6', 600: '#2563eb', 700: '#1d4ed8' },
} as const;

export interface ThemeColors {
  primary: ColorScale;
  accent: ColorScale;
  text: typeof text;
  surface: typeof surface;
  border: Omit<typeof border, 'focus'> & { focus: string };
  semantic: typeof semantic;
}

export function operatorTheme(b: { primaryColor: string; accentColor: string }): ThemeColors {
  const primary = b.primaryColor.toLowerCase() === brand[500] ? brand : generateScale(b.primaryColor);
  return { primary, accent: generateScale(b.accentColor), text, surface, border: { ...border, focus: primary[500] }, semantic };
}

export function cssVariables(t: ThemeColors): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(t.primary)) if (k !== 'DEFAULT') out[`--color-primary-${k}`] = v;
  for (const [k, v] of Object.entries(t.accent)) if (k !== 'DEFAULT') out[`--color-accent-${k}`] = v;
  for (const [k, v] of Object.entries(t.text)) out[`--color-text-${k}`] = v;
  for (const [k, v] of Object.entries(t.surface)) out[`--color-surface-${k}`] = v;
  out['--color-border'] = t.border.DEFAULT;
  out['--color-border-light'] = t.border.light;
  out['--color-border-dark'] = t.border.dark;
  out['--color-border-focus'] = t.border.focus;
  for (const [name, fam] of Object.entries(t.semantic)) for (const [k, v] of Object.entries(fam)) out[`--color-${name}-${k}`] = v;
  return out;
}
