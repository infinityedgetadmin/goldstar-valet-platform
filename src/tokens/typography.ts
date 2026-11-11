export const fontFamilies = {
  display: ['Cormorant Garamond', 'Georgia', 'serif'],
  sans: ['Inter', 'Roboto', 'system-ui', '-apple-system', 'sans-serif'],
  body: ['Roboto', 'system-ui', 'sans-serif'],
} as const;

export interface TypeStyle {
  fontSize: number;
  lineHeight: number;
  letterSpacing?: number;
  fontWeight: 300 | 400 | 500 | 600 | 700 | 900;
}

export const typeScale = {
  'display-2xl': { fontSize: 72, lineHeight: 1.1, letterSpacing: -0.02, fontWeight: 700 },
  'display-xl': { fontSize: 60, lineHeight: 1.1, letterSpacing: -0.02, fontWeight: 700 },
  'display-lg': { fontSize: 48, lineHeight: 1.2, letterSpacing: -0.02, fontWeight: 700 },
  'display-md': { fontSize: 36, lineHeight: 1.2, letterSpacing: -0.01, fontWeight: 700 },
  'display-sm': { fontSize: 30, lineHeight: 1.3, letterSpacing: -0.01, fontWeight: 600 },
  'display-xs': { fontSize: 24, lineHeight: 1.3, fontWeight: 600 },
  'heading-xl': { fontSize: 40, lineHeight: 1.2, letterSpacing: -0.01, fontWeight: 700 },
  'heading-lg': { fontSize: 32, lineHeight: 1.25, letterSpacing: -0.01, fontWeight: 700 },
  'heading-md': { fontSize: 28, lineHeight: 1.3, fontWeight: 600 },
  'heading-sm': { fontSize: 24, lineHeight: 1.4, fontWeight: 600 },
  'heading-xs': { fontSize: 20, lineHeight: 1.4, fontWeight: 600 },
  'body-xl': { fontSize: 20, lineHeight: 1.8, fontWeight: 400 },
  'body-lg': { fontSize: 18, lineHeight: 1.75, fontWeight: 400 },
  'body-md': { fontSize: 16, lineHeight: 1.75, fontWeight: 400 },
  'body-sm': { fontSize: 14, lineHeight: 1.6, fontWeight: 400 },
  'body-xs': { fontSize: 12, lineHeight: 1.5, fontWeight: 400 },
  'ui-xl': { fontSize: 18, lineHeight: 1.5, fontWeight: 500 },
  'ui-lg': { fontSize: 16, lineHeight: 1.5, fontWeight: 500 },
  'ui-md': { fontSize: 14, lineHeight: 1.4, fontWeight: 500 },
  'ui-sm': { fontSize: 13, lineHeight: 1.4, fontWeight: 500 },
  'ui-xs': { fontSize: 12, lineHeight: 1.3, fontWeight: 500 },
} as const satisfies Record<string, TypeStyle>;

export type TypeScaleKey = keyof typeof typeScale;
