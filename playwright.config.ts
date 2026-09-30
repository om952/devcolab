import { defineConfig, devices } from "@playwright/test";

/**
 * Browser-level smoke tests.
 *
 * Boots the real collab-server and web build and drives them through Chromium,
 * so this covers the wiring the unit and integration suites cannot: the client
 * bundle, the auth context, and the browser's Socket.IO connection.
 *
 * Requires Postgres (docker compose up -d postgres) and a prior build:
 *   pnpm build:types && pnpm --filter @devcolab/database build
 *   pnpm build:collab && pnpm build:web
 */

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://devcolab:devcolab@localhost:5433/devcolab";

const COLLAB_PORT = 4100;
const WEB_PORT = 3100;

const collabEnv = {
  NODE_ENV: "development",
  PORT: String(COLLAB_PORT),
  DATABASE_URL,
  JWT_SECRET: "playwright-e2e-secret-at-least-16-chars",
  CORS_ORIGIN: `http://localhost:${WEB_PORT}`,
  LOG_LEVEL: "warn",
  // The suite registers a fresh user per test to keep cases independent, which
  // trips the production 20-per-15-minutes auth limit partway through a run.
  // The limit itself is covered by unit tests; raising it here keeps the
  // browser suite deterministic instead of failing on whichever test happens
  // to be the 21st.
  AUTH_RATE_LIMIT_MAX: "1000",
  // Point at a dead AI service so reviews take the deterministic heuristic
  // path — an e2e smoke test must not depend on a live LLM.
  AI_SERVICE_URL: "http://127.0.0.1:59997",
  // Accept any LLM key without asking Google or Groq; the suite must not depend
  // on a real provider or a real key. The server refuses this in production.
  LLM_KEY_CHECK: "skip",
};

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],

  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },

  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],

  webServer: [
    {
      command: "node apps/collab-server/dist/index.js",
      port: COLLAB_PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: collabEnv,
    },
    {
      // NEXT_PUBLIC_* is inlined at build time, so the bundle must be rebuilt
      // against this run's collab-server port — setting it only at runtime
      // would silently leave the client pointing at the default port.
      command: `pnpm --filter @devcolab/web build && pnpm --filter @devcolab/web start --port ${WEB_PORT}`,
      port: WEB_PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 300_000,
      env: {
        NODE_ENV: "production",
        NEXT_PUBLIC_COLLAB_SERVER_URL: `http://localhost:${COLLAB_PORT}`,
        NEXT_TELEMETRY_DISABLED: "1",
      },
    },
  ],
});
