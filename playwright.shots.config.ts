import { defineConfig } from '@playwright/test';
// App Store screenshots v2 (CAD sheet set). Run: npm run shots:v2
export default defineConfig({
  testDir: './tests/shots',
  timeout: Number(process.env.SHOT_TIMEOUT || 900_000),
  expect: { timeout: 60_000 },
  workers: 1,
  reporter: [['list']],
  use: { baseURL: 'http://localhost:4173/', browserName: 'chromium', acceptDownloads: true },
  webServer: { command: 'npx vite preview --port 4173 --strictPort', url: 'http://localhost:4173/', reuseExistingServer: true },
});
