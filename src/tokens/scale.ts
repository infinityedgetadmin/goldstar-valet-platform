export type ColorScale = Record<50 | 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900 | 'DEFAULT', string>;
function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('');
}
function mix(hex: string, target: [number, number, number], t: number): string {
  const [r, g, b] = hexToRgb(hex);
  return rgbToHex(r + (target[0] - r) * t, g + (target[1] - g) * t, b + (target[2] - b) * t);
}
/** Tint toward white for 50–400, shade toward near-black for 600–900; 500 is the input. */
export function generateScale(hex: string): ColorScale {
  const h = hex.toLowerCase();
  return {
    50: mix(h, [255, 255, 255], 0.94),
    100: mix(h, [255, 255, 255], 0.86),
    200: mix(h, [255, 255, 255], 0.7),
    300: mix(h, [255, 255, 255], 0.5),
    400: mix(h, [255, 255, 255], 0.25),
    500: h,
    600: mix(h, [20, 12, 8], 0.15),
    700: mix(h, [20, 12, 8], 0.32),
    800: mix(h, [20, 12, 8], 0.48),
    900: mix(h, [20, 12, 8], 0.6),
    DEFAULT: h,
  };
}
