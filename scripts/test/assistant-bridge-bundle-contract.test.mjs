// Bundle contract for the AI assistant connector: a production SPA build that
// carries no `VITE_ASSISTANT_BRIDGE_PORT` (the connector is off) contains no
// loopback WebSocket URL, and one that does carries it.
//
// The URL template lives in `loopbackWsUrl` (packages/assistant-protocol) and is
// reached only through `bridgeSocketUrl` (apps/web/src/assistant/bridge-port.ts),
// whose guard is a compile-time constant in such a build, so the bundler drops
// the template with the dead branch. This test builds the real web app twice
// (`vite build` into throwaway directories, NODE_ENV=production exactly as
// `build_spa` pins it) and scans every emitted file.
//
// Heavier than the other scripts/test/ checks (two real Vite builds), so it is a
// plain node:test run by `pnpm test:contracts` (RUN_CONTRACT_TESTS=1) and
// skipped under `pnpm test:scripts`. Pattern: lambda-artifact-contract.test.mjs.

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const WEB_ROOT = resolve(REPO_ROOT, 'apps', 'web');
const BUILD_TIMEOUT_MS = 300_000;
const PORT = '24580';

// The bridge URL, not a bare `127.0.0.1`: the dev-credentials host check
// legitimately names that address and is not a socket URL.
const LOOPBACK_WS_URL = /ws:\/\/127\.0\.0\.1/;

const RUN = process.env.RUN_CONTRACT_TESTS === '1';

describe(
  RUN
    ? 'assistant bridge bundle contract'
    : 'assistant bridge bundle contract (skipped: set RUN_CONTRACT_TESTS=1)',
  { skip: !RUN },
  () => {
    let workDir;
    let unsetDir;
    let setDir;

    /** Builds the SPA into `outDir`; `port` undefined leaves the variable out of the environment entirely. */
    function buildWeb(outDir, port) {
      const env = { ...process.env, NODE_ENV: 'production' };
      delete env.VITE_ASSISTANT_BRIDGE_PORT;
      if (port !== undefined) env.VITE_ASSISTANT_BRIDGE_PORT = port;
      execFileSync('pnpm', ['--filter', '@retirement/web', 'exec', 'vite', 'build', '--outDir', outDir, '--emptyOutDir'], {
        cwd: WEB_ROOT,
        env,
        stdio: 'pipe',
        timeout: BUILD_TIMEOUT_MS,
      });
    }

    /** Every emitted text file under `dir`, as `{ file, text }`. */
    function* emittedFiles(dir) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) yield* emittedFiles(full);
        else if (/\.(js|mjs|html|css|json)$/.test(entry.name)) yield { file: full, text: readFileSync(full, 'utf8') };
      }
    }

    before(
      () => {
        // The repo-root `.env` is read by Vite (`envDir`); a port set there would defeat the unset build.
        const rootEnv = join(REPO_ROOT, '.env');
        if (existsSync(rootEnv) && /^\s*VITE_ASSISTANT_BRIDGE_PORT\s*=\s*\S/m.test(readFileSync(rootEnv, 'utf8'))) {
          throw new Error('The repo-root .env sets VITE_ASSISTANT_BRIDGE_PORT; remove it to run the unset build.');
        }
        workDir = mkdtempSync(join(tmpdir(), 'assistant-bridge-bundle-'));
        unsetDir = join(workDir, 'unset');
        setDir = join(workDir, 'set');
        buildWeb(unsetDir, undefined);
        buildWeb(setDir, PORT);
      },
      { timeout: 2 * BUILD_TIMEOUT_MS },
    );

    after(() => {
      if (workDir) rmSync(workDir, { recursive: true, force: true });
    });

    test('a production build with VITE_ASSISTANT_BRIDGE_PORT unset contains no loopback WebSocket URL', () => {
      const files = [...emittedFiles(unsetDir)];
      assert.ok(files.some((f) => f.file.endsWith('.js')), 'the build emitted JavaScript');
      const offenders = files.filter((f) => LOOPBACK_WS_URL.test(f.text)).map((f) => f.file);
      assert.deepEqual(offenders, [], 'no emitted file may carry a ws://127.0.0.1 URL');
    });

    test('a production build with VITE_ASSISTANT_BRIDGE_PORT set carries the loopback WebSocket URL', () => {
      const offenders = [...emittedFiles(setDir)].filter((f) => LOOPBACK_WS_URL.test(f.text));
      assert.ok(offenders.length > 0, 'the set build must carry the URL template, or the unset check proves nothing');
    });
  },
);
