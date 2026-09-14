import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: ['src/**/*.ts'],
    ignores: ['src/adapters/**', 'src/index.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/adapters/**'],
              message: 'Core modules depend on ports, never adapters.',
            },
            {
              group: ['node:*'],
              message: 'Keep core modules portable across Node and Workers.',
            },
          ],
        },
      ],
    },
  },
);
