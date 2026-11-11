import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['test/rules/**/*.test.ts'], setupFiles: ['test/rules/setup.ts'], testTimeout: 20_000, hookTimeout: 30_000, pool: 'forks', poolOptions: { forks: { singleFork: true } } } });
