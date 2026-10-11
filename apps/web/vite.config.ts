import { defineConfig, loadEnv, type PluginOption } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Load env vars from the repo-root `.env` rather than per-app. Per
// AGENTS.md, the root .env is the canonical env file; without this
// override Vite would read `apps/web/.env` (which doesn't exist) and
// `VITE_*` vars would be undefined. Process-level env still wins, so
// the AWS build's `VITE_API_BASE_URL=""` injection is unaffected.
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// Build id baked into the bundle at compile time. The version-detector
// in the SPA compares this against the `X-Build-Id` header echoed by
// every API response — mismatch → "new version available" banner.
// `dev` short-circuits the detector so vite-dev / vitest don't pop
// the banner against an idle API.
const buildId = process.env.VITE_BUILD_ID ?? process.env.BUILD_ID ?? 'dev';

// Emits `dist/build-id.json` next to `index.html`. The detector fetches
// this at runtime to verify a fresh deploy is actually live on CloudFront
// before showing the "new version" banner — the api Lambda flips its
// `X-Build-Id` ~30–90s before S3 sync + CF invalidation finish, so a
// mismatch on the API alone would prompt before the new bundle is
// fetchable. See apps/web/src/lib/build-id.ts.
function emitBuildIdJsonPlugin(id: string): PluginOption {
  return {
    name: 'emit-build-id-json',
    apply: 'build',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'build-id.json',
        source: JSON.stringify({ buildId: id }),
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  // `loadEnv` reads `VITE_*` from the repo-root `.env` (the canonical env
  // file per AGENTS.md, via `rootDir`) AND merges process-env `VITE_*` on
  // top (process env wins). Vite does NOT load `.env` into `process.env`,
  // so the documented `VITE_PORT=` line in a checkout's root `.env` only
  // reaches the dev server through `loadEnv`; a shell-prefixed
  // `VITE_PORT=… pnpm dev` (the second-worktree launch) still wins via
  // process env. `VITE_BUILD_ID`/`BUILD_ID` stay process-env-only (read at
  // module scope above) — those are deliberate AWS-build injections.
  const env = loadEnv(mode, rootDir, 'VITE_');
  return {
    plugins: [react(), tailwindcss(), emitBuildIdJsonPlugin(buildId)],
    envDir: rootDir,
    define: {
      __BUILD_ID__: JSON.stringify(buildId),
    },
    server: {
      // Bind host. Default `127.0.0.1` (loopback only) so a `pnpm dev` server
      // — which can render seeded credentials / dev token shortcuts — is not
      // reachable from the LAN by default.
      // Set `VITE_HOST=0.0.0.0` in the root `.env` to opt IN to LAN exposure so
      // a phone or second machine can reach the dev app. Read via `loadEnv`
      // since Vite does not push `.env` into `process.env`; a shell-prefixed
      // `VITE_HOST=…` still wins.
      host: env.VITE_HOST?.trim() || '127.0.0.1',
      // Default 5173; `VITE_PORT` (root `.env` or a process/shell-prefixed
      // env var, which wins) overrides it so a second checkout (e.g. a
      // second worktree) can run its own `pnpm dev` without colliding
      // on the port. Unset ⇒ literal 5173 ⇒ zero behaviour change.
      // `strictPort` stays on so a busy chosen port fails loud rather than
      // silently rebinding.
      port: Number(env.VITE_PORT?.trim() || 5173),
      strictPort: true,
    },
  };
});
