import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  use: { baseURL: 'http://localhost:4173', trace: 'retain-on-failure' },
  webServer: {
    command: 'node node_modules/tsx/dist/cli.mjs scripts/test-server.ts',
    url: 'http://localhost:4173',
    reuseExistingServer: false,
  },
  projects: [
    {
      name: 'tablet-chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1180, height: 820 }, hasTouch: true },
    },
    { name: 'phone-webkit', use: { ...devices['iPhone 13'], defaultBrowserType: 'webkit' } },
  ],
});
