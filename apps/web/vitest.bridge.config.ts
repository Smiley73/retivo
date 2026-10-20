import { defineConfig } from 'vitest/config';

// The suites that dial the real, built apps/mcp-bridge (`pnpm --filter
// @retirement/web test:bridge`). They live beside the code as
// `*.bridge-test.ts`, which neither project in vitest.config.ts includes, and
// run under Node: the session is framework free and speaks to the bridge over
// Node's own WebSocket.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.bridge-test.ts'],
    // Each test starts a bridge subprocess and waits on real sockets.
    testTimeout: 20_000,
  },
});
