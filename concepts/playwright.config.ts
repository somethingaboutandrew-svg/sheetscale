import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: '.', testMatch: /scene\.spec\.ts$/, timeout: 120000, use: { baseURL: 'http://localhost:4173/', acceptDownloads: true, browserName: 'chromium' } });
