import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/perf', testMatch: /\.perf\.ts$/, workers: 1, timeout: 30 * 60_000, reporter: [['list']],
  webServer: process.env.PM_BASE_URL ? undefined : { command: 'npx vite preview --port 4173 --strictPort', url: 'http://localhost:4173/', reuseExistingServer: true },
});
