import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'coverage/**', 'playwright-report/**', 'test-results/**', 'specs/**'] },
  ...tseslint.configs.recommended,
  {
    // Module code reaches data only through ModuleContext (spec 003 R-10): it may import types from @sync/modules and nothing else from @sync/*.
    files: ['packages/sample-app/modules/**', 'packages/sample-app/runtime-modules/**'],
    rules: {
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-restricted-imports': ['error', { patterns: [
        { group: ['@sync/core', '@sync/core/*', '@sync/spaces', '@sync/spaces/*', '@sync/blobs', '@sync/blobs/*', '@sync/identity-invite', '@sync/transport-*', '@sync/relay-server', '@sync/testkit', '@sync/app-build'], message: 'Modules get data through ModuleContext; import only types from @sync/modules.' },
        { regex: '^@sync/modules$', allowTypeImports: true, message: 'Import only types from @sync/modules (the migration helpers are at @sync/modules/migrate).' },
      ] }],
    },
  },
  {
    // Key access stays in one reviewed file (spec 004 T004): @sync/spaces values are imported only from crypto/keys.ts.
    files: ['packages/blobs/src/**'],
    ignores: ['packages/blobs/src/crypto/keys.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', { patterns: [
        { regex: '^@sync/spaces', allowTypeImports: true, message: 'Only crypto/keys.ts may import @sync/spaces values; type imports are fine.' },
      ] }],
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
);
