/**
 * Config-resolution test for the coverage-mode worker-pool pin in
 * `apps/web/vitest.config.ts`. The outcome it guards (CI stops flaking on
 * timeout-only failures) is inherently untestable — no unit test proves "CI
 * doesn't flake" — so this locks the deterministic mechanism instead.
 *
 * The pin is CI-ONLY. It originally keyed off
 * `VITEST_COVERAGE` alone, but the `test:coverage` script sets that LOCALLY
 * too, so a developer machine ran the whole suite single-threaded regardless of
 * its core count (measured: 654s → 217s on a 14-core box once the pin stopped
 * firing locally). The justification — "1 matches the 2-vCPU ubuntu-latest
 * runner's own default" — is a claim about the RUNNER, so the guard tests for
 * the runner. Hence three branches below: only coverage-AND-CI pins.
 *
 * The config module reads `process.env` once at import time, so each branch
 * needs a fresh module evaluation: `vi.resetModules()` + `await import()` per
 * branch, with the env vars set/deleted beforehand. `CI` is saved and restored
 * alongside `VITEST_COVERAGE` because it IS set on CI, where this test also
 * runs — without that, the local-branch assertion would read the runner's own
 * `CI` and pass for the wrong reason.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('vitest.config maxWorkers pin', () => {
  const originalCoverage = process.env.VITEST_COVERAGE;
  const originalCi = process.env.CI;

  function restore(key: 'VITEST_COVERAGE' | 'CI', value: string | undefined): void {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  afterEach(() => {
    restore('VITEST_COVERAGE', originalCoverage);
    restore('CI', originalCi);
    vi.resetModules();
  });

  async function resolveMaxWorkers(): Promise<number | string | undefined> {
    vi.resetModules();
    return (await import('../../vitest.config')).default.test?.maxWorkers;
  }

  it('pins maxWorkers to 1 only under coverage ON CI', async () => {
    process.env.VITEST_COVERAGE = '1';
    process.env.CI = 'true';
    expect(await resolveMaxWorkers()).toBe(1);
  });

  it('leaves maxWorkers undefined under coverage OFF CI (local runs use every core)', async () => {
    // The regression this exists to prevent: keying the pin on VITEST_COVERAGE
    // alone silently serialized `pnpm test:coverage` on developer machines.
    process.env.VITEST_COVERAGE = '1';
    delete process.env.CI;
    expect(await resolveMaxWorkers()).toBeUndefined();
  });

  it('leaves maxWorkers undefined without coverage, on CI or off it', async () => {
    delete process.env.VITEST_COVERAGE;
    delete process.env.CI;
    expect(await resolveMaxWorkers()).toBeUndefined();

    process.env.CI = 'true';
    expect(await resolveMaxWorkers()).toBeUndefined();
  });
});
