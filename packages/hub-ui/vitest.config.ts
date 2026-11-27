import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['tests/**/*.test.ts'], environment: 'jsdom', testTimeout: 60_000 },
});
