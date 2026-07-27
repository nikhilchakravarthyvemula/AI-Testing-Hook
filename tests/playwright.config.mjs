// Playwright config for the crawler-generated UI/E2E tests (tests/e2e/**).
//
// Auth model: every test context starts pre-seeded with the SAME session the
// crawler used — output/crawler/auth-state.json (cookies + localStorage +
// IndexedDB; the IndexedDB part is what makes Firebase-auth apps authenticate).
// Auth-gate specs opt OUT per-file via `test.use({ storageState: {...} })`
// to assert that anonymous requests are rejected.
//
// Mode: TEST_MODE=safe|full is read by the generated specs (see helpers/
// mode.mjs). Config-side we only wire auth + reporting; the skip decisions
// live in the specs so they show up in the report as skipped, not absent.
//
// Run (normally invoked by `ctx execute`, not by hand):
//   BASE_URL=https://<target> TEST_MODE=safe \
//     npx playwright test --config tests/playwright.config.mjs
import { defineConfig } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const AUTH_STATE = path.join(REPO_ROOT, 'output', 'crawler', 'auth-state.json');
const REPORT_DIR = path.join(REPO_ROOT, 'output', 'generation', 'e2e');

// Fall back to the crawled target so a bare run still works.
function detectBaseUrl() {
  if (process.env.BASE_URL) return process.env.BASE_URL;
  try {
    const routes = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'output', 'crawler', 'data', 'routes.json'), 'utf8'));
    const first = (routes.pages || [])[0]?.url;
    if (first) return new URL(first).origin;
  } catch {}
  return 'http://localhost:3000';
}

export default defineConfig({
  testDir: path.join(__dirname, 'e2e'),
  timeout: 45_000,
  retries: 0,
  workers: 2,                      // gentle on staging; the crawler auth is shared
  reporter: [
    ['list'],
    ['json', { outputFile: path.join(REPORT_DIR, 'results.json') }],
    ['html', { outputFolder: path.join(REPORT_DIR, 'html'), open: 'never' }],
  ],
  use: {
    baseURL: detectBaseUrl(),
    storageState: fs.existsSync(AUTH_STATE) ? AUTH_STATE : undefined,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  outputDir: path.join(REPORT_DIR, 'artifacts'),
});
