import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: './tests', testMatch: /desktop\.electron\.ts$/, reporter: [['list']], timeout: 180_000 });
