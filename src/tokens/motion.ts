export const motion = {
  duration: { fast: 120, base: 200, slow: 320 },
  easing: { standard: [0.2, 0, 0, 1] as const, emphasized: [0.3, 0, 0, 1] as const, exit: [0.4, 0, 1, 1] as const },
} as const;
