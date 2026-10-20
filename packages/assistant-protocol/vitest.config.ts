import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/index.ts'],
      // At or above the web app's line threshold (85); the package is small
      // and pure, so the rest sit well above the web app's.
      thresholds: { lines: 90, statements: 90, functions: 90, branches: 85 },
    },
  },
});
