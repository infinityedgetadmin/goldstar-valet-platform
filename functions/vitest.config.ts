import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    testTimeout: 20_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    coverage: { provider: 'v8', thresholds: { statements: 90, branches: 90 } },
  },
});
