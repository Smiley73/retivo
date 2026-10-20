import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // The process-lifecycle tests start the built bin; allow for a loaded machine.
    testTimeout: 15_000,
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary'],
      include: ['src/**/*.ts'],
      // bin.ts is only ever run by the subprocess test, in a child process
      // that coverage does not see; test-support holds the test helpers.
      exclude: ['src/**/*.test.ts', 'src/test-support/**', 'src/bin.ts'],
      // At or above the web app's line threshold (85); the bridge is small and
      // its state machines are exercised in-process, so the rest sit above the
      // web app's too.
      thresholds: { lines: 90, statements: 90, functions: 90, branches: 85 },
    },
  },
});
