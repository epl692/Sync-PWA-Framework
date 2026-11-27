import { defineConfig } from 'vitest/config';

// Used when running from inside a package (npm run test -w <package>). The root vitest.config.ts covers the whole repo.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    benchmark: { include: ['bench/**/*.bench.ts'] },
    environment: 'node',
    testTimeout: 60_000,
  },
});
