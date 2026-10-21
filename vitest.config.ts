import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/tests/**/*.test.ts'],
    benchmark: { include: ['packages/*/bench/**/*.bench.ts'] },
    environment: 'node',
    testTimeout: 60_000,
    // CONVERGENCE_RUNS / CONVERGENCE_SEED are read by the property tests.
  },
});
