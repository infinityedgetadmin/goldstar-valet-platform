import js from '@eslint/js';
import tseslint from 'typescript-eslint';
export default tseslint.config(js.configs.recommended, ...tseslint.configs.strictTypeChecked, {
  languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
  rules: {
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/consistent-type-imports': 'error',
    '@typescript-eslint/no-non-null-assertion': 'off',
    '@typescript-eslint/restrict-template-expressions': 'off',
  },
}, {
  // scripts/emulator-config.mjs (infra task, task-platform-report.md) is deliberately plain
  // vanilla ESM JS, not TypeScript — it's not part of scripts/tsconfig.json's `include: ["*.ts"]`,
  // so typescript-eslint's `projectService` (typed linting) has no project to resolve it against.
  ignores: ['dist', 'functions', 'test', 'scripts/emulator-config.mjs', 'scripts/emulator-data-dir.mjs'],
});
