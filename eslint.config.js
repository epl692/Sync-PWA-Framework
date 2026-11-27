import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'coverage/**', 'playwright-report/**', 'test-results/**', 'specs/**', 'hubs/**/android/**', 'hubs/**/sidecar-*/**', 'hubs/**/node_modules/**'] },
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
    // The Hub holds no content keys (spec 005 FR-011, SC-004): it never imports @sync/spaces, not even types.
    files: ['packages/hub-core/src/**'],
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', { patterns: [
        { group: ['@sync/spaces', '@sync/spaces/*'], message: 'The Hub holds no content keys and must not import @sync/spaces.' },
      ] }],
    },
  },
  {
    // Only webBluetooth.ts touches the browser API (spec 005 T006), so tests can inject the simulator.
    files: ['packages/transport-bluetooth/src/**'],
    ignores: ['packages/transport-bluetooth/src/webBluetooth.ts'],
    rules: {
      'no-restricted-properties': ['error', { object: 'navigator', property: 'bluetooth', message: 'Use the BluetoothLike seam in webBluetooth.ts.' }],
      'no-restricted-globals': ['error', { name: 'navigator', message: 'Use the BluetoothLike seam in webBluetooth.ts.' }],
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
);
