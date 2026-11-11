import { defineConfig } from 'tsup';
export default defineConfig({
  entry: { index: 'src/index.ts', 'tokens/index': 'src/tokens/index.ts' },
  format: ['esm', 'cjs'], dts: true, clean: true, sourcemap: true, target: 'es2022', tsconfig: 'tsconfig.build.json',
});
