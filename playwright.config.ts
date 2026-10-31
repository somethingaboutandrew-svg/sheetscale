import { defineConfig } from '@playwright/test';
// PM_BASE_URL=https://somethingaboutandrew-svg.github.io/sheetscale/ runs the suite against a deployed copy.
const remote = process.env.PM_BASE_URL;
export default defineConfig({
  testDir: './tests',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  workers: 2,
  reporter: [['list']],
  use: {
    baseURL: remote || 'http://localhost:4173/',
    viewport: { width: 1500, height: 950 },
    acceptDownloads: true,
    browserName: 'chromium',
  },
  webServer: remote ? undefined : {
    command: 'npx vite preview --port 4173 --strictPort',
    url: 'http://localhost:4173/',
    reuseExistingServer: true,
  },
});
