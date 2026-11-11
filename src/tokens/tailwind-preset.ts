import { accent, border, brand, semantic, surface, text } from './colors';
import { fontFamilies, typeScale, type TypeStyle } from './typography';
import { radii, spacing } from './spacing';

type FontSizeValue = readonly [string, { lineHeight: string; letterSpacing: string | undefined; fontWeight: string }];
const fontSize: Record<string, FontSizeValue> = Object.fromEntries(
  (Object.entries(typeScale) as Array<[string, TypeStyle]>).map(
    ([k, v]): [string, FontSizeValue] => [
      k,
      [`${v.fontSize}px`, { lineHeight: String(v.lineHeight), letterSpacing: v.letterSpacing ? `${v.letterSpacing}em` : undefined, fontWeight: String(v.fontWeight) }],
    ],
  ),
);

export const tailwindPreset = {
  theme: {
    extend: {
      colors: { primary: brand, accent, text, bg: surface, border, success: semantic.success, error: semantic.error, warning: semantic.warning, info: semantic.info },
      fontFamily: { display: [...fontFamilies.display], sans: [...fontFamilies.sans], body: [...fontFamilies.body] },
      fontSize,
      spacing: Object.fromEntries(Object.entries(spacing).map(([k, v]) => [k, `${v}px`])),
      borderRadius: Object.fromEntries(Object.entries(radii).map(([k, v]) => [k, `${v}px`])),
    },
  },
};
