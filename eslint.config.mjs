import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'playwright-report/**', 'test-results/**', 'Docs/**', '.data/**'] },
  { files: ['**/*.ts', '**/*.tsx'], extends: [eslint.configs.recommended, ...tseslint.configs.recommended] },
);
