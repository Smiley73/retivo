// Lambda artifact reproducibility contract.
//
// The deployable Lambda artifact is produced by `pnpm --filter
// @retirement/api build:lambda` (apps/api/scripts/build-lambda.mjs). This test
// builds it into a throwaway directory and asserts the supply-chain invariants
// it locks in:
//
//   - the artifact is lockfile-derived: no package-lock.json and no
//     artifact-local registry install (`npm install`) anywhere in the build
//     path — the graph comes from `pnpm deploy` against the committed lockfile;
//   - every direct production dependency ships at the exact version the tested
//     workspace resolved (dependency parity, no drift);
//   - the staged tree contains zero symbolic links (Lambda's zip layer handles
//     them poorly and they defeat byte-traceability);
//   - the uncompressed artifact stays under Lambda's 250 MiB limit;
//   - the artifact survives an archive/extract round-trip and every one of the
//     six deployed handler entrypoints imports from the extracted tree, with
//     `require()` of ES modules switched off as it is in the Lambda runtime;
//   - the production dependency graph passes the audit gate.
//
// This is heavier than the other scripts/test/ contract checks (it runs a real
// nest build + pnpm deploy) but stays a pure node:test with no infra harness,
// run by `pnpm test:contracts` (RUN_CONTRACT_TESTS=1); skipped under
// `pnpm test:scripts`. Pattern: scripts/test/csp-contract.test.mjs.

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const API_ROOT = resolve(REPO_ROOT, 'apps', 'api');
const BUILD_SCRIPT_SRC = resolve(API_ROOT, 'scripts', 'build-lambda.mjs');

// The six entrypoints Pulumi deploys (five via infrastructure/src/lambda.ts,
// one via infrastructure/src/signup-cascade.ts). Each must import cleanly from
// the extracted artifact, proving the hoisted package graph is complete.
const DEPLOYED_HANDLERS = [
  'lambda.js',
  'compactor-lambda.js',
  'janitor-lambda.js',
  'signup-cascade-lambda.js',
  'account-snapshot-purge-lambda.js',
  'health-check-probe-lambda.js',
];

const MAX_UNCOMPRESSED_BYTES = 250 * 1024 * 1024; // Lambda's uncompressed cap.
const BUILD_TIMEOUT_MS = 600_000;

const RUN = process.env.RUN_CONTRACT_TESTS === '1';

describe(
  RUN
    ? 'lambda artifact contract'
    : 'lambda artifact contract (skipped: set RUN_CONTRACT_TESTS=1)',
  { skip: !RUN },
  () => {
  let workDir;
  let artifactDir;

  // Build the artifact ONCE into a temp dir, shared by every assertion below.
  before(
    () => {
      workDir = mkdtempSync(join(tmpdir(), 'lambda-artifact-contract-'));
      artifactDir = join(workDir, 'artifact');
      execFileSync('pnpm', ['--filter', '@retirement/api', 'build:lambda'], {
        cwd: REPO_ROOT,
        env: { ...process.env, LAMBDA_BUILD_OUTPUT_DIR: artifactDir },
        stdio: 'pipe',
        timeout: BUILD_TIMEOUT_MS,
      });
    },
    { timeout: BUILD_TIMEOUT_MS },
  );

  after(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  /** Recursively yields absolute paths of every entry (files, dirs, symlinks). */
  function* walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      yield { full, entry };
      if (entry.isDirectory()) yield* walk(full);
    }
  }

  test('build-lambda.mjs never runs an artifact-local registry install', () => {
    const raw = readFileSync(BUILD_SCRIPT_SRC, 'utf8');
    // Scan executable code only — the docstring intentionally describes the
    // supply-chain rationale ("no artifact-local `npm install`"), which must not
    // be mistaken for the command itself.
    const code = raw
      .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
      .replace(/(^|[^:])\/\/.*$/gm, '$1'); // line comments (leave `://` intact)
    assert.doesNotMatch(
      code,
      /\bnpm\s+(install|ci|i)\b/,
      'build-lambda.mjs must not run `npm install`/`npm ci` — the graph must come from the lockfile via `pnpm deploy`',
    );
    assert.doesNotMatch(
      code,
      /package-lock\.json/,
      'build-lambda.mjs must never create or consume a package-lock.json',
    );
    assert.match(
      code,
      /pnpm[\s\S]*deploy/,
      'build-lambda.mjs must stage prod deps via `pnpm deploy`',
    );
    assert.match(
      code,
      /inject-workspace-packages=true/,
      'the deploy must inject workspace packages (non-legacy) so no `npm install` is needed',
    );
    assert.match(
      code,
      /deploy[\s\S]*--frozen-lockfile/,
      'the deploy must pass `--frozen-lockfile` so a stale manifest/lockfile fails the build loudly instead of re-resolving fresh dependency versions (the committed-lockfile supply-chain guarantee)',
    );
  });

  test('the artifact contains no package lock', () => {
    assert.ok(
      !existsSync(join(artifactDir, 'package-lock.json')),
      'artifact must not contain a package-lock.json',
    );
    assert.ok(
      !existsSync(join(artifactDir, 'node_modules', '.package-lock.json')),
      'artifact must not contain an npm-written node_modules/.package-lock.json',
    );
  });

  test('every direct production dependency matches the locked workspace version', () => {
    const apiPkg = JSON.parse(
      readFileSync(join(API_ROOT, 'package.json'), 'utf8'),
    );
    const deps = Object.keys(apiPkg.dependencies ?? {}).filter(
      // @retirement/contracts is a workspace package injected as a real copy;
      // it carries no registry version to compare against.
      (name) => !apiPkg.dependencies[name].startsWith('workspace:'),
    );
    assert.ok(deps.length > 0, 'expected direct production dependencies to check');
    for (const name of deps) {
      const artifactPkgPath = join(
        artifactDir,
        'node_modules',
        ...name.split('/'),
        'package.json',
      );
      const workspacePkgPath = join(
        API_ROOT,
        'node_modules',
        ...name.split('/'),
        'package.json',
      );
      assert.ok(
        existsSync(artifactPkgPath),
        `artifact is missing production dependency ${name}`,
      );
      const artifactVersion = JSON.parse(
        readFileSync(artifactPkgPath, 'utf8'),
      ).version;
      const workspaceVersion = JSON.parse(
        readFileSync(workspacePkgPath, 'utf8'),
      ).version;
      assert.equal(
        artifactVersion,
        workspaceVersion,
        `${name} in the artifact (${artifactVersion}) must match the tested workspace version (${workspaceVersion})`,
      );
    }
  });

  test('the staged artifact contains zero symbolic links', () => {
    const symlinks = [];
    for (const { full, entry } of walk(artifactDir)) {
      if (entry.isSymbolicLink()) symlinks.push(full);
    }
    assert.deepEqual(
      symlinks,
      [],
      `the artifact must contain no symlinks; found: ${symlinks.join(', ')}`,
    );
  });

  test('the uncompressed artifact stays under the 250 MiB Lambda limit', () => {
    let totalBytes = 0;
    for (const { full, entry } of walk(artifactDir)) {
      if (entry.isFile()) totalBytes += lstatSync(full).size;
    }
    assert.ok(
      totalBytes < MAX_UNCOMPRESSED_BYTES,
      `uncompressed artifact is ${(totalBytes / 1024 / 1024).toFixed(1)} MiB, exceeding the 250 MiB limit`,
    );
  });

  test('the artifact survives an archive round-trip and every handler imports', () => {
    const archive = join(workDir, 'artifact.tgz');
    const extractDir = join(workDir, 'extracted');
    rmSync(extractDir, { recursive: true, force: true });
    execFileSync('tar', ['-czf', archive, '-C', artifactDir, '.']);
    execFileSync('mkdir', ['-p', extractDir]);
    execFileSync('tar', ['-xzf', archive, '-C', extractDir]);

    for (const handler of DEPLOYED_HANDLERS) {
      const handlerPath = join(extractDir, handler);
      assert.ok(
        existsSync(handlerPath),
        `extracted artifact is missing handler ${handler}`,
      );
      // Import in a subprocess so each handler is exercised against the
      // extracted tree in isolation (a missing/broken dependency throws a
      // nonzero exit here). `--no-experimental-require-module` matches the
      // Lambda Node.js runtime, where CommonJS code cannot `require()` an ES
      // module. Plain Node 24 allows it, so without the flag a CommonJS
      // dependency that loads an ESM-only package passes here and then fails
      // at start-up on Lambda with ERR_REQUIRE_ESM.
      execFileSync(
        process.execPath,
        [
          '--no-experimental-require-module',
          '--input-type=module',
          '-e',
          `const m = await import(${JSON.stringify(handlerPath)}); if (typeof m.handler !== 'function') { throw new Error('no handler export'); }`,
        ],
        { stdio: 'pipe', timeout: 60_000 },
      );
    }
  });

  test('the production dependency graph passes the audit gate', () => {
    // Mirrors the workspace `audit:ci` gate but scoped to the production graph
    // the artifact ships. Honors pnpm-workspace.yaml's auditConfig.ignoreGhsas.
    // CI sets AUDIT_ADVISORIES_NONBLOCKING=true only on a pull request that
    // changes no dependency file; main, dispatch and local runs stay strict.
    try {
      execFileSync('pnpm', ['audit', '--prod', '--audit-level=moderate'], {
        cwd: REPO_ROOT,
        stdio: 'pipe',
        timeout: 120_000,
      });
    } catch (error) {
      if (process.env.AUDIT_ADVISORIES_NONBLOCKING !== 'true') throw error;
      console.warn(
        'production audit reported advisories (not blocking: this PR changes no dependencies)',
      );
    }
  });
  },
);
