/*
 * Jest config — also the single env-bootstrap point for the API
 * integration suite.
 *
 * This file is evaluated in the jest-main process *before* the worker
 * pool forks, and `globalTeardown` runs in that same jest-main process.
 * So this is the one place that:
 *   1. loads the repo-root `.env` (dotenv),
 *   2. forces the emulator endpoint/credential defaults, and
 *   3. stamps a per-run `JEST_RUN_ID` (guarded — only if unset, so a
 *      hypothetical worker re-require can't clobber the inherited id;
 *      jest-main is first, workers inherit it via the fork-time env
 *      snapshot, `global-teardown.ts` sees the same value directly).
 *
 * `jest.setup.ts` (per-worker) and `global-teardown.ts` (jest-main)
 * both inherit all of the above and fail loud if `JEST_RUN_ID` is
 * unset. The per-worker table/bucket namespace is
 * `retirement-test-${JEST_RUN_ID}-${JEST_WORKER_ID}-…`, so two
 * concurrent jest processes (e.g. two worktrees) never
 * share DynamoDB Local / Moto state and `--maxWorkers` can run the
 * suite in parallel for speed. Within a single worker namespace the
 * existing unique-data discipline (random uuid emails/devices,
 * per-household scoping) is still load-bearing.
 */
const { resolve } = require('node:path');
require('dotenv').config({
  path: resolve(__dirname, '..', '..', '.env'),
});

// Always hit the local emulator from tests; never real AWS. Hoisted
// here (out of jest.setup.ts) so the jest-main `globalTeardown` — which
// never runs jest.setup.ts — inherits the same endpoints/creds with no
// duplication.
process.env.DYNAMODB_ENDPOINT =
  process.env.DYNAMODB_ENDPOINT ?? 'http://localhost:8000';
process.env.S3_ENDPOINT = process.env.S3_ENDPOINT ?? 'http://localhost:5001';
process.env.AWS_REGION = process.env.AWS_REGION ?? 'us-east-1';
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? 'test';
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? 'test';

// Per-run id: the jest-main pid. Guarded so whoever sets first wins —
// jest-main runs this config before forking, workers inherit it, and
// `global-teardown.ts` (same jest-main process) reads the identical
// value with no process-tree/ppid assumption.
process.env.JEST_RUN_ID ||= String(process.pid);

module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testRegex: '.*\\.spec\\.ts$',
  // 30s ceiling (up from jest's 5s default): DynamoDB Local + Moto round
  // trips legitimately exceed 5s when the api jest suite and web vitest
  // suite contend for CPU under `pnpm test`. The 5s default was a false-
  // timeout signal, not a deadlock guard — no passing test relies on a
  // sub-5s fast-fail.
  testTimeout: 30000,
  // Each worker owns a private `retirement-test-${JEST_RUN_ID}-${JEST_WORKER_ID}-*`
  // namespace (see jest.setup.ts), so parallel workers no longer collide
  // on rows or table creation. The 50% cap is a *local* co-tenancy concern:
  // two concurrent worktrees co-fit one machine without CPU
  // thrash. CI has no co-tenant — the runner is dedicated to this one job —
  // so it uses all vCPUs.
  maxWorkers: process.env.CI ? '100%' : '50%',
  moduleFileExtensions: ['ts', 'js', 'json'],
  moduleNameMapper: {
    // Resolve the `@retirement/contracts` workspace package to its TypeScript
    // SOURCE. The package publishes an ESM-only `exports` map (a `types` + an
    // `import` condition, no `require`/`default`), which Jest's CJS resolver
    // can't satisfy — `@retirement/contracts` fails to resolve at all without
    // this. Pointing at `src` lets @swc/jest transform it like the app's own
    // `.ts` (the `.js` re-export specifiers inside it fall through to the
    // relative-`.js` mapper below), and tests read the live source with no
    // dependence on a prior `dist` build.
    '^@retirement/contracts$': '<rootDir>/../../packages/contracts/src/index.ts',
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  setupFiles: ['<rootDir>/src/test/jest.setup.ts'],
  globalTeardown: '<rootDir>/src/test/global-teardown.ts',
  // Coverage is collected only when `--coverage` is passed (the
  // `test:coverage` script / CI gate) — plain `pnpm test` stays
  // uninstrumented. `coverageProvider: 'v8'` is required with @swc/jest:
  // the default istanbul instrumentation is not wired into the swc
  // transform and silently reports near-zero coverage.
  coverageProvider: 'v8',
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/test/**',
    '!src/**/*.spec.ts',
    '!src/main.ts',
    '!src/**/*.d.ts',
  ],
  // Thresholds ratchet toward the ~80% CODING_STANDARDS target: set
  // slightly below the measured baseline, raise-only (lowering needs a
  // documented justification in the PR). Enforced only under --coverage.
  // Baseline from CI's first main run (2026-06): lines/statements 89.6 /
  // branches 79.9 / functions 95.7.
  coverageThreshold: {
    global: {
      lines: 87,
      statements: 87,
      functions: 93,
      branches: 76,
    },
  },
  // otplib v13's entire dependency tree (otplib, @otplib/*, @scure/base,
  // @noble/hashes) ships as pure ESM (`"type": "module"`). Jest's default
  // `transformIgnorePatterns` (`/node_modules/`) skips transforming anything
  // under node_modules, so requiring these packages throws `SyntaxError:
  // Unexpected token 'export'` — which breaks every AppModule-importing test
  // (src/auth/mfa.service.ts pulls in otplib's functional API). Narrow the
  // skip with a negative lookahead so swc still transforms just these ESM
  // packages, matching pnpm's `.pnpm/<pkg>@<version>/node_modules/…` layout;
  // everything else in node_modules stays untransformed. Pre-existing break
  // from the otplib v13 bump, unrelated to any specific feature.
  transformIgnorePatterns: [
    '/node_modules/\\.pnpm/(?!(@scure\\+base|@noble\\+hashes|@otplib\\+[a-z0-9-]+|otplib)@)',
  ],
  transform: {
    '^.+\\.tsx?$': [
      '@swc/jest',
      {
        jsc: {
          parser: { syntax: 'typescript', decorators: true },
          transform: { legacyDecorator: true, decoratorMetadata: true },
          target: 'es2022',
        },
      },
    ],
    // Companion to the transformIgnorePatterns exemption above: otplib v13's
    // runtime deps @scure/base and @noble/hashes ship ONLY pure-ESM `.js`
    // (no CommonJS build at all), so once the pattern stops ignoring them
    // jest still needs a transformer to rewrite their `import`/`export` to
    // CJS — the `.tsx?` transform above doesn't match `.js`. An
    // ecmascript-syntax swc pass handles just those un-ignored ESM `.js`
    // files (@swc/jest emits CJS under jest's non-ESM runtime; `.cjs`
    // dist builds still load natively and are untouched). Same pre-existing
    // otplib v13 break, unrelated to any specific feature.
    '^.+\\.jsx?$': [
      '@swc/jest',
      {
        jsc: {
          parser: { syntax: 'ecmascript' },
          target: 'es2022',
        },
      },
    ],
  },
};
