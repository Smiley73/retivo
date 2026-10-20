/**
 * Playwright config for the web app's end-to-end suite.
 *
 * Coverage scope is deliberately small (see `e2e/`): app boot, demo
 * import, account create, Balance Projection render, Plan stress-test
 * auto-run, scenario switch re-runs it, plus two cross-page
 * journeys (scenario edit → projection update; expense → reload
 * persistence). Each test runs against a fresh workspace — the fixture
 * purges the dev household's server rows (DynamoDB Local), clears
 * IndexedDB + cookies, and signs back in (see e2e/fixtures.ts).
 *
 * The suite needs the FULL local stack: emulators (`pnpm emu:up`) +
 * API + web (`pnpm dev` from the repo root). Playwright's `webServer`
 * auto-starts only the Vite dev server; the API must already be up —
 * every flow starts from a real sign-in as the seeded dev user
 * (`dev@local.test`), because the app's demo-data surfaces all sit
 * behind authentication. One worker to avoid Vite-HMR / IDB races
 * across parallel tabs.
 */
import { defineConfig, devices } from '@playwright/test';

const PORT = 5173;
const BASE_URL = `http://localhost:${PORT}`;
/** The loopback port the AI assistant journey's bridge listens on (the same number is in e2e/assistant.spec.ts). */
const ASSISTANT_BRIDGE_PORT = 24581;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  // Generous ceilings (Playwright default 30s): the first tests of a run
  // pay Vite's cold on-demand transform of the full app module graph
  // INSIDE their test budget (the signed-in fixture runs per test), and
  // the demo seed's client-side encrypt+push can need 120s+ of the same
  // cold 2-vCPU runner (see loadDemo in e2e/fixtures.ts).
  timeout: process.env.CI ? 240_000 : 60_000,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: BASE_URL,
    // retain-on-first-failure (not retain-on-failure): a flaky test —
    // fails, then passes on retry — counts as passed, and with
    // retain-on-failure its failing attempt leaves no trace behind.
    // Flaky first attempts are exactly what needs diagnosing while the
    // suite earns blocking status.
    trace: 'retain-on-first-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm dev',
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    // The AI assistant journey needs a build that carries a bridge port (the connector is off without one).
    env: { VITE_ASSISTANT_BRIDGE_PORT: String(ASSISTANT_BRIDGE_PORT) },
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
