import { globSync } from 'node:fs';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Lib engine tests are DOM-free and run under the faster `node` environment
// (the `unit-node` project). The files below are the exception: they still
// need jsdom because they import `@testing-library/*`, render JSX, or touch
// browser-only globals (`document`/`window`/`localStorage`) that Node does
// not provide, so they run in the `unit-dom` project alongside the
// component/page suites. This list is the single source of truth for the
// split: `unit-node` runs every *other* `src/lib/**/*.test.ts`, and
// `unit-dom` excludes exactly what `unit-node` owns, so no file runs twice.
// `fake-indexeddb` is a pure-JS polyfill that works under node — do NOT add
// a file here just because it uses IndexedDB.
const LIB_TESTS_NEEDING_JSDOM: readonly string[] = [
  // Uses window-scoped session storage for the dismissed-build state.
  'src/lib/build-id.test.ts',
  // Touches `document` (captures/exports the live console log surface).
  'src/lib/diagnostics/export.test.ts',
  // Installs against `document`/`window` console + event surfaces.
  'src/lib/diagnostics/install.test.ts',
  // Reads `window` (bootstraps expense categories from a rendered context).
  'src/lib/expense-categories-bootstrap.test.ts',
  // Renders via `@testing-library/react` `renderHook`.
  'src/lib/use-aggregates.test.ts',
  // Renders JSX + `renderHook` via `@testing-library/react`.
  'src/lib/use-chart-zoom.test.ts',
  // Renders JSX + `renderHook` via `@testing-library/react`; touches `window`.
  'src/lib/use-selected-scenario-revision.test.ts',
];

// Every `src/lib/**/*.test.ts` that does NOT need jsdom → the node project.
// Derived (not hand-listed) so new lib tests default to node automatically;
// only the jsdom exceptions above are maintained by hand.
const libNodeTests = globSync('src/lib/**/*.test.ts', {
  cwd: import.meta.dirname,
}).filter((file) => !LIB_TESTS_NEEDING_JSDOM.includes(file));

// Playwright e2e specs (`e2e/*.spec.ts`) run via `pnpm test:e2e` against a
// real browser, not vitest's jsdom runner. Exclude them (plus build output)
// from both projects so `pnpm test` doesn't try to execute them.
const baseExclude = ['**/node_modules/**', '**/dist/**', 'e2e/**'];

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    setupFiles: ['src/test/setup.ts'],
    // Default 5s is too tight for compute-heavy suites (e.g. the Monte Carlo engine
    // suites' many-path runs) once CI's v8 coverage instrumentation + 4-way parallel sharding contend for a 2-vCPU runner — this has intermittently
    // timed out suites with no assertion/import error. Bumped only under coverage (VITEST_COVERAGE=1, set by the
    // CI web-unit/test:coverage steps) so the fast local `pnpm test` loop
    // keeps failing fast on a genuine hang. Per-test overrides (e.g.
    // PlanStressTestSection.parity.test.ts's own coverage-aware timeout) still win.
    testTimeout: process.env.VITEST_COVERAGE === '1' ? 30_000 : 5_000,
    // Pin the worker-pool size to 1 for CI's coverage run instead of leaving it
    // to vitest's implicit `max(numCpus - 1, 1)` default. Both projects
    // (unit-node/unit-dom) share ONE pool via groupSpecs, so this single
    // root-level `maxWorkers` caps them together. PROVISIONAL: `1` matches
    // today's default on the 2-vCPU ubuntu-latest runner, so it changes no
    // current CI behavior — it's an explicit, reviewable contract guarding
    // against a future runner-tier upgrade silently re-introducing contention,
    // pending the CI diagnostic step's real CPU-count data (not a proven
    // flakiness fix).
    //
    // **CI-ONLY, deliberately.** This used to key off `VITEST_COVERAGE` alone,
    // which the `test:coverage` script sets LOCALLY too — so a developer
    // machine ran the whole suite single-threaded regardless of its core count
    // (measured: 654s on a 14-core box, ~10x under-parallelized).
    // The 2-vCPU justification above is a statement about the RUNNER, so the
    // guard now tests for the runner. Locally `maxWorkers` stays `undefined` in
    // both modes and vitest's own default resolution applies. Note this is a
    // narrower condition than the `testTimeout` split just above, which stays
    // coverage-keyed on purpose: v8 instrumentation slows tests everywhere,
    // including locally, but only the CI runner is core-starved.
    maxWorkers:
      process.env.VITEST_COVERAGE === '1' && process.env.CI ? 1 : undefined,
    // Tests never hit the network (fetch is mocked at the boundary), but
    // src/lib/api-base-url.ts throws at module load if the env var is
    // missing. Pin a value here so tests don't depend on a root .env or
    // on CI exporting the var.
    env: {
      VITE_API_BASE_URL: 'http://localhost:3001',
      // Disable the idle-timeout timer by default so suites that don't
      // exercise it aren't perturbed by activity listeners + tab-storage
      // sync. Suites that *do* exercise it render <IdleTimer/> directly
      // with explicit idleMs/warnLeadMs.
      VITE_IDLE_TIMEOUT_MIN: '0',
    },
    // Two environments, one suite: DOM-free `src/lib` engine tests run under
    // the faster `node` environment; everything else (component/page suites,
    // and the lib tests that genuinely need jsdom) runs under `jsdom` — the
    // pre-split behavior. Both projects inherit the plugins, `setupFiles`,
    // `env`, and aliases above via `extends: true`. Coverage stays configured
    // at the root (below) so it merges across both projects and CI's 4-way
    // `--shard` + blob-merge flow is unchanged.
    projects: [
      {
        extends: true,
        test: {
          name: 'unit-node',
          environment: 'node',
          include: libNodeTests,
          exclude: baseExclude,
        },
      },
      {
        extends: true,
        test: {
          name: 'unit-dom',
          environment: 'jsdom',
          include: ['src/**/*.{test,spec}.{ts,tsx}'],
          // `unit-node` owns the DOM-free lib tests; exclude exactly those so
          // nothing runs in both projects. The jsdom-needing lib tests
          // (LIB_TESTS_NEEDING_JSDOM) are NOT in this derived set, so they
          // still run here under jsdom.
          exclude: [...baseExclude, ...libNodeTests],
        },
      },
    ],
    // Coverage runs only via `pnpm test:coverage` (CI gate) — plain
    // `pnpm test` stays uninstrumented so the local merge gate stays fast.
    // Thresholds ratchet toward the ~80% CODING_STANDARDS target: set
    // slightly below the measured baseline, raise-only (lowering needs a
    // documented justification in the PR).
    //
    // VITEST_SHARDED=1 (set by the CI shard steps) suppresses the
    // thresholds: a single shard only covers its slice of the suite, so
    // per-shard enforcement would always fail. The merge step
    // (`vitest run --merge-reports --coverage`, run WITHOUT the flag)
    // combines the shard blobs and enforces the thresholds once over the
    // full picture. Local `pnpm test:coverage` is unsharded → enforced.
    coverage: {
      provider: 'v8',
      // Sharded steps skip report generation entirely: raw V8 coverage
      // travels inside the blob and the merge step regenerates the real
      // report from the combined blobs, so per-shard tables are dead
      // output — and the v8 provider's report phase intermittently
      // crashes on CI runners (a bare "undefined" printed right after
      // "blob report written", exit 1) AFTER every test already passed.
      // No per-shard report generation → no crash site.
      reporter:
        process.env.VITEST_SHARDED === '1' ? [] : ['text-summary', 'lcov'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/test/**',
        'src/**/*.test.{ts,tsx}',
        'src/**/*.bench.ts',
        'src/**/*.d.ts',
        'src/main.tsx',
        // Thin library-call wrappers (svg2pdf/jspdf invocation) —
        // untestable in jsdom. The thin render step inside build-pdf.ts is
        // fenced with `c8 ignore` rather than excluded so its pure section-
        // model assembly stays covered.
        'src/lib/pdf-export/capture-chart-svg.ts',
        'src/lib/pdf-export/lazy-load.ts',
      ],
      // Baseline at introduction: lines 86.9 / statements 83.9 /
      // functions 81.9 / branches 74.0.
      thresholds:
        process.env.VITEST_SHARDED === '1'
          ? undefined
          : {
              lines: 85,
              statements: 82,
              functions: 80,
              branches: 71,
            },
    },
  },
});
