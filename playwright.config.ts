import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  use: {
    browserName: 'chromium',
    headless: true,
    baseURL: 'http://localhost:4173',
    // Let two pages on one machine see each other's local addresses (Chrome hides them behind mDNS names by default).
    launchOptions: {
      args: ['--disable-features=WebRtcHideLocalIpsWithMdns'],
      // Optional: point at an already installed Chromium (for example in a sandbox where `playwright install` is not possible).
      executablePath: process.env.PW_CHROMIUM_PATH || undefined,
    },
  },
  webServer: [
    { command: 'node scripts/e2e-server.mjs', port: 4173, reuseExistingServer: true },
    { command: 'npx tsx packages/relay-server/src/server.ts', port: 8787, reuseExistingServer: true, env: { PORT: '8787', BLOB_DIR: 'test-results/blob-relay' } },
  ],
});
