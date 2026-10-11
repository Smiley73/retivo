#!/usr/bin/env node
/**
 * Bundles the API Nest app into a deployable Lambda artifact.
 *
 * Inputs : every Lambda entry under apps/api/src — the api handler
 *          (lambda.ts) plus the standalone handlers (compactor-lambda.ts,
 *          janitor-lambda.ts, signup-cascade-lambda.ts,
 *          account-snapshot-purge-lambda.ts,
 *          health-check-probe-lambda.ts). All six ship in one artifact;
 *          Pulumi selects the handler entry per-Lambda.
 * Output : apps/api/build/lambda/  (referenced by Pulumi as a FileArchive),
 *          or the directory named by $LAMBDA_BUILD_OUTPUT_DIR when set (the
 *          artifact-contract test points this at a temp dir).
 *
 * Strategy — the runtime dependency graph is derived ENTIRELY from the
 * committed root pnpm-lock.yaml, never from a fresh registry resolution, so
 * the deployed graph is byte-traceable to what the test suite ran against:
 *   1. Build the @retirement/contracts workspace package FIRST, so both the
 *      subsequent `nest build` typecheck and the injected workspace copy see
 *      the same fresh contracts output (guards against a stale
 *      packages/contracts/dist when src/ was edited without a reinstall).
 *   2. `nest build` compiles src/ -> dist/. Output is ESM with .js
 *      extensions, matching the package.json `"type": "module"`.
 *   3. `pnpm deploy` (NON-legacy: --config.inject-workspace-packages=true
 *      --config.node-linker=hoisted, driven by the root lockfile + the pinned
 *      pnpm from package.json `packageManager`) stages a --prod-only, flat
 *      (hoisted) node_modules into a staging dir. inject-workspace-packages
 *      copies @retirement/contracts in as a real directory (not a symlink),
 *      so no `workspace:*`/`file:` tarball rewrite and no artifact-local
 *      registry install (`npm install`) is needed. `--legacy` is deliberately
 *      NOT used: legacy + hoisted resolution ignores the workspace lock and
 *      selects newer AWS SDK/Nest packages than the tested tree.
 *   4. Assemble build/lambda/: the staged node_modules + the deployed
 *      prod-only package.json, then the compiled dist/ contents flattened to
 *      the artifact root (source maps excluded) so each handler lands flat
 *      (build/lambda/lambda.js, compactor-lambda.js, janitor-lambda.js,
 *      signup-cascade-lambda.js, account-snapshot-purge-lambda.js,
 *      health-check-probe-lambda.js) at the path Pulumi's
 *      per-Lambda handler entry expects.
 *   5. Delete every node_modules/.bin directory, at any depth — runtime-
 *      unused, and the only symlink source in the hoisted deploy. pnpm's
 *      hoisted linker nests a package's own node_modules (with its own
 *      .bin) under it whenever that package's dependency graph can't hoist
 *      flat (e.g. two required major versions of the same transitive
 *      dependency collide), so a top-level-only removal is not sufficient —
 *      any such nested .bin is walked and removed too. The rest of
 *      node_modules (including any .pnpm content) is left intact so the
 *      hoisted package graph stays complete.
 *
 * No package-lock.json is ever created or consumed in the artifact path.
 *
 * Every Lambda shares this single artifact. Pulumi configures the
 * handler entry per-Lambda (lambda.handler, compactor-lambda.handler,
 * janitor-lambda.handler, signup-cascade-lambda.handler,
 * account-snapshot-purge-lambda.handler,
 * health-check-probe-lambda.handler).
 */
import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(here, '..');
const repoRoot = resolve(apiRoot, '..', '..');
const distDir = resolve(apiRoot, 'dist');
const buildDir = process.env.LAMBDA_BUILD_OUTPUT_DIR
  ? resolve(process.env.LAMBDA_BUILD_OUTPUT_DIR)
  : resolve(apiRoot, 'build', 'lambda');
const stagingDir = resolve(dirname(buildDir), `${basename(buildDir)}-staging`);

function step(label) {
  console.log(`\n==> ${label}`);
}

/**
 * Recursively removes every directory literally named `.bin` under `dir`, at
 * any depth — not just a top-level node_modules/.bin. pnpm's hoisted linker
 * nests a private node_modules (with its own .bin) under a package whenever
 * that package's own dependency graph can't hoist flat, so a single
 * top-level removal misses those. Every `.bin` entry is a symlink, so this is
 * the artifact's only symlink source at any depth.
 */
function removeAllBinDirs(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = resolve(dir, entry.name);
    if (entry.name === '.bin') {
      rmSync(full, { recursive: true, force: true });
      continue;
    }
    removeAllBinDirs(full);
  }
}

step('Building @retirement/contracts (fresh, before nest build typechecks against it)');
const contractsRoot = resolve(apiRoot, '..', '..', 'packages', 'contracts');
execSync('pnpm --filter @retirement/contracts run build', {
  cwd: apiRoot,
  stdio: 'inherit',
});
const contractsDist = resolve(contractsRoot, 'dist');
if (!existsSync(contractsDist)) {
  console.error(`error: ${contractsDist} not produced by contracts build`);
  process.exit(1);
}

step('Compiling TypeScript via nest build');
execSync('pnpm exec nest build', { cwd: apiRoot, stdio: 'inherit' });
if (!existsSync(distDir)) {
  console.error(`error: ${distDir} not produced by nest build`);
  process.exit(1);
}

step(`Recreating ${buildDir}`);
rmSync(buildDir, { recursive: true, force: true });
rmSync(stagingDir, { recursive: true, force: true });
mkdirSync(buildDir, { recursive: true });

step('Staging prod dependencies via pnpm deploy (lockfile-derived, hoisted, injected)');
// Non-legacy deploy: injects @retirement/contracts as a real copy and
// resolves every prod dependency from the committed root lockfile into a
// flat (hoisted) node_modules. Filtered to @retirement/api and run from the
// repo root. No `npm install`, no package-lock.json, no `--legacy`.
// --frozen-lockfile forbids any lockfile mutation: a stale manifest/lockfile
// (outside CI, where frozen is not the default) fails the build loudly
// instead of silently re-resolving fresh dependency versions — the
// committed-lockfile supply-chain guarantee this artifact depends on.
execSync(
  `pnpm --filter @retirement/api deploy --prod --frozen-lockfile --config.inject-workspace-packages=true --config.node-linker=hoisted ${JSON.stringify(stagingDir)}`,
  { cwd: repoRoot, stdio: 'inherit' },
);
const stagedNodeModules = resolve(stagingDir, 'node_modules');
const stagedPkgJson = resolve(stagingDir, 'package.json');
if (!existsSync(stagedNodeModules) || !existsSync(stagedPkgJson)) {
  console.error(`error: pnpm deploy did not produce ${stagedNodeModules}`);
  process.exit(1);
}

step('Assembling artifact (node_modules + prod package.json + flattened dist)');
cpSync(stagedNodeModules, resolve(buildDir, 'node_modules'), {
  recursive: true,
});
cpSync(stagedPkgJson, resolve(buildDir, 'package.json'));
// Flatten the compiled tree to the artifact root (source maps excluded — .map
// files are filtered out so they are not shipped) so every handler resolves at
// the path Pulumi's per-Lambda handler entry expects.
cpSync(distDir, buildDir, {
  recursive: true,
  filter: (src) => !src.endsWith('.map'),
});

step(
  'Removing every node_modules/.bin directory, at any depth (runtime-unused, the only symlink source)',
);
removeAllBinDirs(resolve(buildDir, 'node_modules'));

step('Cleaning up staging directory');
rmSync(stagingDir, { recursive: true, force: true });

step('Done');
console.log(`Lambda artifact ready at ${buildDir}`);
