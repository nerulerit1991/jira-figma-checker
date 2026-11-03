import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.js$/,
  timeout: 30_000,
  expect: { timeout: 7_000 },
  retries: 0,
  workers: 2,
  outputDir: process.env.TEST_OUTPUT_DIR || '.output',
  reporter: [['json', { outputFile: process.env.TEST_REPORT_FILE || 'report.json' }]],
  use: { baseURL: process.env.TEST_BASE_URL, storageState: process.env.STORAGE_STATE || undefined, headless: true, trace: 'off', screenshot: 'off' },
});
