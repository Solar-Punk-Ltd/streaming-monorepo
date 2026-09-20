import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parserOptions: {
        project: [
          './web2-admin/backend/tsconfig.typecheck.json',
          './web2-admin/common/tsconfig.json',
          './web2-admin/frontend/tsconfig.json',
        ],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-misused-promises': [
        'error',
        {
          checksVoidReturn: {
            attributes: false,
          },
        },
      ],
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          allowForKnownSafeCalls: [
            {
              from: 'package',
              package: 'node:test',
              name: [
                'after',
                'afterEach',
                'before',
                'beforeEach',
                'describe',
                'it',
                'suite',
                'test',
              ],
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      '**/src/domain/FakeFeedGateway.ts',
      '**/test/unit/support/authFixtures.ts',
      '**/test/unit/support/fakes.ts',
    ],
    rules: {
      // These in-memory fakes implement ports whose methods return promises.
      '@typescript-eslint/require-await': 'off',
    },
  },
);
