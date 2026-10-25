// The config module reads `process.env` once at import, so each branch resets modules and imports a fresh copy. The pin is CI-only: keyed on VITEST_COVERAGE alone it serialized `pnpm test:coverage` on developer machines (654s to 217s once fixed), and the 2-vCPU claim is about the runner. `CI` is saved and restored so the local branch does not read the runner's own.
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
